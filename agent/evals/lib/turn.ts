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
 * - first visible word: from the `delivery.consumed` that took in the
 *   message to the first non-blank text `content.delta`, or to the first
 *   text `content.completed` when the model did not stream. eve 1.0 stamps a
 *   delta with the time of the last line it stored before it, such as the end
 *   of the model's thinking or the start of its run. With Thinking off, that
 *   leaves out the model's wait for its first token. Reasoning does not count,
 *   because the person sees nothing until the reply starts.
 * - total: from that `delivery.consumed` to the last event of the turn.
 * - tool time: the time any tool call was running, from `call.requested` to
 *   `call.settled`, with overlapping calls counted once.
 */
import type {
  EveEvalActionStatus,
  EveEvalSession,
  EveEvalToolCall,
  EveEvalTurn,
} from "eve/evals";
import type { Setup, ToolCall, TurnTiming } from "./schema.ts";
import { setupHeaders } from "./setup.ts";

/** Anything with eve's `send`: the eval context `t`, or a session. */
export interface TurnSender {
  send: EveEvalSession["send"];
}

/** The fields of a stream event that timing reads. A `SessionStreamEvent` fits. */
export interface TimedEvent {
  readonly data?: unknown;
  readonly meta?: { readonly at?: string };
  readonly type: string;
}

export interface TurnMeasure {
  /** The model id of each model attempt, in order, from `model.started`. */
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

/** Whether a `delivery.consumed` took in text the person sent. */
function consumedText(event: TimedEvent): boolean {
  const parts = field(event, "parts");
  return (
    event.type === "delivery.consumed" &&
    Array.isArray(parts) &&
    parts.some(
      (part) => isRecord(part) && part.kind === "text" && hasText(part.text)
    )
  );
}

/** The events of the last turn: from the delivery that took in its message. */
function lastTurnEvents(events: readonly TimedEvent[]): readonly TimedEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (consumedText(events[index])) {
      return events.slice(index);
    }
  }
  return events;
}

/**
 * The kind of each content part, from its `content.completed`. A delta may
 * leave out its kind, and its part's completion names it.
 */
function partKinds(events: readonly TimedEvent[]): Map<string, unknown> {
  const kinds = new Map<string, unknown>();
  for (const event of events) {
    const partId = field(event, "partId");
    if (event.type === "content.completed" && typeof partId === "string") {
      kinds.set(partId, field(event, "kind"));
    }
  }
  return kinds;
}

/** Whether an event shows the person reply text: a delta or a finished part. */
function showsText(event: TimedEvent, kinds: Map<string, unknown>): boolean {
  if (event.type === "content.delta") {
    const partId = field(event, "partId");
    const kind =
      field(event, "kind") ??
      (typeof partId === "string" ? kinds.get(partId) : undefined);
    return kind === "text" && hasText(field(event, "delta"));
  }
  return (
    event.type === "content.completed" &&
    field(event, "kind") === "text" &&
    hasText(field(event, "value"))
  );
}

/** When the person first sees reply text, if they ever do. */
function firstVisibleAt(events: readonly TimedEvent[]): number | undefined {
  const kinds = partKinds(events);
  for (const event of events) {
    const at = timeOf(event);
    if (at !== undefined && showsText(event, kinds)) {
      return at;
    }
  }
  return undefined;
}

function callIdOf(event: TimedEvent): string | undefined {
  const callId = field(event, "callId");
  return typeof callId === "string" ? callId : undefined;
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
    if (event.type === "call.requested") {
      const id = callIdOf(event);
      if (id !== undefined) {
        requestedAt.set(id, at);
      }
    } else if (event.type === "call.settled") {
      const id = callIdOf(event);
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
    return event.type === "model.started" && typeof modelId === "string"
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

/**
 * A call's status as a transcript row stores it. A call that was interrupted,
 * or never ran because its turn ended, did not complete, so it counts as
 * failed.
 */
function transcriptCallStatus(status: EveEvalActionStatus): ToolCall["status"] {
  switch (status) {
    case "completed":
    case "failed":
    case "pending":
    case "rejected":
      return status;
    default:
      return "failed";
  }
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
    status: transcriptCallStatus(call.status),
  }));
}

/**
 * A turn's status as the "turn works" check reads it. A turn that waits for
 * a person is waiting. One that was cancelled, or whose delivery had not
 * settled when the watch stopped, did not finish, so it counts as failed.
 */
export function turnWorksStatus(
  status: EveEvalTurn["status"] | undefined
): TurnWorksInput["status"] {
  if (status === "completed") {
    return "completed";
  }
  return status === "awaiting-input" ? "waiting" : "failed";
}

// ---------------------------------------------------------------------------
// "Turn works"
// ---------------------------------------------------------------------------

const THINK_TAG = /<\/?think(?:ing)?>/iu;
/**
 * What a model prints when its tool call comes out as text instead of a call.
 * The `<|...|>` pattern is any special token, which covers lfm2.5's
 * `<|tool_call_start|>`, Llama's `<|python_tag|>`, and gpt-oss's
 * `<|channel|>` and `<|call|>`. It needs both bars and a short name, so a bar
 * in ordinary writing does not match. gpt-oss also names the function after
 * `to=functions.`.
 */
const TOOL_CALL_SYNTAX = [
  /<\/?tool_call>/iu,
  /<\|?tool_call\|?>/iu,
  /<function[=\s>]/iu,
  /<\|[^\s<>|]{1,64}\|>/u,
  /\bto=functions\.\w/u,
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
