/**
 * Sending a Chat turn for an eval, and timing it.
 *
 * Eval files never call `send` on eve's context or session directly. They go
 * through `sendTurn`, which always passes the `x-sage-*` headers. eve drops
 * request headers between turns of one session, so a follow-up turn without
 * them would quietly run the agent's default model with thinking on.
 *
 * Timing comes from the event stream, not from a clock in the eval process,
 * so it measures the server's work and not the client's wait:
 * - first visible word: from `message.received` to the first non-blank
 *   `message.appended`. Reasoning events do not count, because the person
 *   sees nothing until the reply starts.
 * - total: from `message.received` to the last event of the turn.
 * - tool time: the time any tool call was running, with overlapping calls
 *   counted once.
 */
import type { EveEvalSession, EveEvalToolCall, EveEvalTurn } from "eve/evals";
import type { Setup, ToolCall, TurnTiming } from "./schema.ts";
import { setupHeaders } from "./setup.ts";

/** Anything with eve's `send`: the eval context `t`, or a session. */
export interface TurnSender {
  send: EveEvalSession["send"];
}

/** The fields of a stream event that timing reads. A `MessageStreamEvent` fits. */
export interface TimedEvent {
  readonly data?: unknown;
  readonly meta?: { readonly at?: string };
  readonly type: string;
}

export interface TurnMeasure {
  /** The model id of each step, in order, as reported on `step.started`. */
  stepModelIds: string[];
  timing: TurnTiming;
}

export interface TimedTurn extends TurnMeasure {
  turn: EveEvalTurn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timeOf(event: TimedEvent): number | undefined {
  const at = event.meta?.at;
  if (typeof at !== "string") {
    return undefined;
  }
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

function field(event: TimedEvent, name: string): unknown {
  return isRecord(event.data) ? event.data[name] : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** The events of the last turn: from its `message.received` on. */
function lastTurnEvents(events: readonly TimedEvent[]): readonly TimedEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "message.received") {
      return events.slice(index);
    }
  }
  return events;
}

/** When the person first sees reply text, if they ever do. */
function firstVisibleAt(events: readonly TimedEvent[]): number | undefined {
  const times = (type: string, key: string) =>
    events.flatMap((event) => {
      const at = timeOf(event);
      return event.type === type &&
        hasText(field(event, key)) &&
        at !== undefined
        ? [at]
        : [];
    });
  // A model that does not stream still ends its message with a completed event.
  return (
    times("message.appended", "messageDelta")[0] ??
    times("message.completed", "message")[0]
  );
}

function callIdsOf(event: TimedEvent): string[] {
  const actions = field(event, "actions");
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.flatMap((action) =>
    isRecord(action) && typeof action.callId === "string" ? [action.callId] : []
  );
}

function resultCallId(event: TimedEvent): string | undefined {
  const result = field(event, "result");
  return isRecord(result) && typeof result.callId === "string"
    ? result.callId
    : undefined;
}

/** Milliseconds covered by at least one interval. */
function unionMs(intervals: [number, number][]): number {
  const sorted = [...intervals].sort(([a], [b]) => a - b);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [from, to] of sorted) {
    const begin = Math.max(from, end);
    if (to > begin) {
      total += to - begin;
    }
    end = Math.max(end, to);
  }
  return total;
}

function toolMsOf(events: readonly TimedEvent[]): number {
  const requestedAt = new Map<string, number>();
  const intervals: [number, number][] = [];
  for (const event of events) {
    const at = timeOf(event);
    if (at === undefined) {
      continue;
    }
    if (event.type === "actions.requested") {
      for (const id of callIdsOf(event)) {
        requestedAt.set(id, at);
      }
    } else if (event.type === "action.result") {
      const id = resultCallId(event);
      const from = id === undefined ? undefined : requestedAt.get(id);
      if (from !== undefined) {
        intervals.push([from, at]);
      }
    }
  }
  return unionMs(intervals);
}

/**
 * Timing and step models for the last turn in `events`. Events without a
 * usable `meta.at` are skipped. A turn with no events times as zero.
 */
export function measureTurn(events: readonly TimedEvent[]): TurnMeasure {
  const turnEvents = lastTurnEvents(events);
  const times = turnEvents.flatMap((event) => timeOf(event) ?? []);
  const stepModelIds = turnEvents.flatMap((event) => {
    const modelId = field(event, "modelId");
    return event.type === "step.started" && typeof modelId === "string"
      ? [modelId]
      : [];
  });
  if (times.length === 0) {
    return {
      stepModelIds,
      timing: { firstVisibleMs: null, toolMs: 0, totalMs: 0 },
    };
  }
  const [startMs] = times;
  const visibleAt = firstVisibleAt(turnEvents);
  return {
    stepModelIds,
    timing: {
      firstVisibleMs:
        visibleAt === undefined ? null : Math.max(visibleAt - startMs, 0),
      toolMs: toolMsOf(turnEvents),
      totalMs: Math.max(Math.max(...times) - startMs, 0),
    },
  };
}

/**
 * Sends one message with the setup's `x-sage-*` headers and times the turn.
 * Pass the eval context `t` for a first message, or a session for a follow-up.
 */
export async function sendTurn(
  target: TurnSender,
  text: string,
  setup: Setup
): Promise<TimedTurn> {
  // Built first, so an unsupported thinking value stops before anything is sent.
  const headers = setupHeaders(setup);
  const turn = await target.send(text, { headers });
  return { ...measureTurn(turn.events), turn };
}

/** The tool calls of a turn in the shape a transcript row stores. */
export function toTranscriptToolCalls(
  calls: readonly EveEvalToolCall[]
): ToolCall[] {
  return calls.map((call) => ({
    // eve's JSON types are readonly and the schema's are not. The values are the same.
    input: call.input as ToolCall["input"],
    name: call.name,
    ...(call.output === undefined
      ? {}
      : { output: call.output as ToolCall["output"] }),
    status: call.status,
  }));
}

// ---------------------------------------------------------------------------
// "Turn works"
// ---------------------------------------------------------------------------

const THINK_TAG = /<\/?think(?:ing)?>/iu;
const TOOL_CALL_SYNTAX = [
  /<\/?tool_call>/iu,
  /<\|?tool_call\|?>/iu,
  /<function[=\s>]/iu,
  /<\|python_tag\|>/iu,
  /\[TOOL_CALLS?\]/u,
  /"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|parameters)"\s*:/u,
] as const;
const OLLAMA_PREFIX = "ollama/";

function bareModelId(id: string): string {
  return id.startsWith(OLLAMA_PREFIX) ? id.slice(OLLAMA_PREFIX.length) : id;
}

export interface TurnWorksInput {
  /** The chat model the setup asked for. */
  chatModel: string;
  /** Whether the turn parked on a question for the person instead of ending. */
  parkedOnInput?: boolean;
  replyText: string;
  status: "completed" | "failed" | "waiting";
  stepModelIds: readonly string[];
}

/**
 * The "turn works" check: the turn finished, the reply is visible text with no
 * `<think>` tags or tool-call syntax in it, and every step ran the model the
 * setup asked for. `problems` lists each way it failed, in plain words.
 */
export function checkTurnWorks(input: TurnWorksInput): {
  pass: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (input.status === "failed") {
    problems.push("the turn failed");
  }
  if (input.parkedOnInput === true) {
    problems.push("the turn stopped to wait for input");
  }
  if (input.status !== "failed" && input.replyText.trim().length === 0) {
    problems.push("the reply is empty");
  }
  if (THINK_TAG.test(input.replyText)) {
    problems.push("the reply leaks a <think> tag");
  }
  if (TOOL_CALL_SYNTAX.some((pattern) => pattern.test(input.replyText))) {
    problems.push("the reply leaks tool-call syntax");
  }
  const asked = bareModelId(input.chatModel);
  const others = [
    ...new Set(
      input.stepModelIds.map(bareModelId).filter((id) => id !== asked)
    ),
  ];
  if (others.length > 0) {
    problems.push(
      `the setup asked for ${asked} but a step ran ${others.join(", ")}`
    );
  }
  return { pass: problems.length === 0, problems };
}
