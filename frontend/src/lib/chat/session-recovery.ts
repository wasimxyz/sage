import {
  ClientError,
  defaultMessageReducer,
  type EveAgentReducer,
  type EveAgentReducerEvent,
  type EveMessageData,
} from "eve/client";

const historyContextPreamble =
  "The earlier conversation was restored after a session restart. Use it as context and do not quote it back wholesale.";
const omittedMarker = "_Earlier messages were omitted._\n\n";
const transcriptLimitBytes = 12 * 1024;
const turnSeparator = "\n\n";
const encoder = new TextEncoder();

export function isSessionNotActiveError(error: unknown): boolean {
  if (error instanceof ClientError) {
    return (
      error.status === 409 &&
      (error.code === "session_not_active" ||
        error.message === "The session is no longer active.")
    );
  }
  return (
    error instanceof Error &&
    error.message.includes("The session is no longer active.")
  );
}

export function buildHistoryTranscript(
  events: readonly EveAgentReducerEvent[]
): string {
  const turns: string[] = [];
  for (const event of events) {
    const user = eventMessage(event, "message.received");
    if (user !== null) {
      turns.push(`**User**\n${user}`);
      continue;
    }
    const assistant = eventMessage(event, "message.completed");
    if (assistant !== null) {
      turns.push(`**Assistant**\n${assistant}`);
    }
  }
  if (turns.length === 0) {
    return "";
  }
  const joined = turns.join(turnSeparator);
  if (utf8ByteLength(joined) <= transcriptLimitBytes) {
    return joined;
  }
  return trimTranscriptToLimit(turns);
}

export function historyClientContext(
  events: readonly EveAgentReducerEvent[]
): string | undefined {
  const transcript = buildHistoryTranscript(events);
  if (transcript.length === 0) {
    return undefined;
  }
  return `${historyContextPreamble}\n\n${transcript}`;
}

function eventMessage(
  event: EveAgentReducerEvent,
  type: string
): string | null {
  if (event.type !== type || !("data" in event)) {
    return null;
  }
  const { data } = event;
  if (typeof data !== "object" || data === null || !("message" in data)) {
    return null;
  }
  const { message } = data;
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  return message;
}

function trimTranscriptToLimit(turns: readonly string[]): string {
  const markerBytes = utf8ByteLength(omittedMarker);
  const budget = Math.max(0, transcriptLimitBytes - markerBytes);
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const piece = turns[index];
    const separatorBytes = kept.length === 0 ? 0 : turnSeparator.length;
    const extra = utf8ByteLength(piece) + separatorBytes;
    if (kept.length > 0 && used + extra > budget) {
      break;
    }
    kept.unshift(piece);
    used += extra;
  }
  return `${omittedMarker}${kept.join(turnSeparator)}`;
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * eve keys projected assistant messages by turn id (`turn_0:assistant`, …)
 * and user messages by `meta.id` (`${meta.id}:user`). A fresh session starts
 * turn ids again at `turn_0`. A recovered conversation holds two sessions'
 * events in one saved log, so without disambiguation the fresh session's
 * first turn overwrites the restored history's first turn in the projection —
 * the new user message lands on top of the old one and the assistant replies
 * merge into one bubble.
 *
 * This wrapper suffixes the instance of each reused turn id: within one
 * session a turn id is used once, so a turn id that reappears after its turn
 * completed, failed, or was cancelled belongs to a later session. Keying on
 * reuse (rather than on `session.started` position) stays correct when the
 * store moves a `message.received` ahead of its `session.started`, which is
 * what the optimistic-submit replacement does on the first turn of a recovered
 * session. Only the projection sees the suffix; the stored event log keeps the
 * original events untouched.
 *
 * Saved chats from eve 0.59 may omit `meta` on `message.received`. The 0.66
 * reducer reads `meta.id` without a fallback, so this wrapper fills that id
 * from the turn id (and sequence, when present) before reducing.
 */
export function sessionNamespacingReducer(): EveAgentReducer<EveMessageData> {
  const inner = defaultMessageReducer();
  let tracking = freshTurnTracking();
  return {
    initial: () => {
      // The store reprojects the whole log from initial() whenever it rewrites
      // an event (e.g. optimistic submit -> received), so turn tracking must
      // restart with each fresh projection.
      tracking = freshTurnTracking();
      return inner.initial();
    },
    reduce: (data, event) =>
      inner.reduce(
        data,
        ensureReceivedMessageMeta(namespaceReusedTurn(event, tracking))
      ),
  };
}

export function projectedMessageIdAtSeq(
  events: readonly EveAgentReducerEvent[],
  seq: number
): string | null {
  if (seq < 0 || seq >= events.length) {
    return null;
  }
  const reducer = sessionNamespacingReducer();
  let data = reducer.initial();
  for (let index = 0; index <= seq; index += 1) {
    const event = events[index];
    if (!event) {
      return null;
    }
    data = reducer.reduce(data, event);
  }
  const event = events[seq];
  if (!event) {
    return null;
  }
  let role: "assistant" | "user" | null = null;
  if (event.type === "message.received") {
    role = "user";
  } else if (event.type === "message.completed") {
    role = "assistant";
  }
  if (role === null) {
    return null;
  }
  for (let index = data.messages.length - 1; index >= 0; index -= 1) {
    const message = data.messages[index];
    if (message?.role === role) {
      return message.id;
    }
  }
  return null;
}

interface TurnTracking {
  completedTurns: Set<string>;
  turnInstance: Map<string, number>;
}

function freshTurnTracking(): TurnTracking {
  return { completedTurns: new Set(), turnInstance: new Map() };
}

function readTurnId(event: EveAgentReducerEvent): string | null {
  if (!("data" in event)) {
    return null;
  }
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("turnId" in data)) {
    return null;
  }
  const { turnId } = data;
  return typeof turnId === "string" ? turnId : null;
}

function namespaceReusedTurn(
  event: EveAgentReducerEvent,
  tracking: TurnTracking
): EveAgentReducerEvent {
  const turnId = readTurnId(event);
  if (turnId === null) {
    return event;
  }
  if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  ) {
    const instance = tracking.turnInstance.get(turnId) ?? 0;
    tracking.completedTurns.add(turnId);
    return withTurnInstance(event, turnId, instance);
  }
  let instance = tracking.turnInstance.get(turnId) ?? 0;
  if (tracking.completedTurns.has(turnId)) {
    instance += 1;
    tracking.completedTurns.delete(turnId);
  }
  tracking.turnInstance.set(turnId, instance);
  return withTurnInstance(event, turnId, instance);
}

function withTurnInstance(
  event: EveAgentReducerEvent,
  turnId: string,
  instance: number
): EveAgentReducerEvent {
  if (instance === 0 || !("data" in event)) {
    return event;
  }
  return {
    ...event,
    data: { ...event.data, turnId: `${turnId}#${instance}` },
  } as EveAgentReducerEvent;
}

function hasMetaId(event: EveAgentReducerEvent): boolean {
  if (!("meta" in event)) {
    return false;
  }
  const { meta } = event;
  if (typeof meta !== "object" || meta === null || !("id" in meta)) {
    return false;
  }
  return typeof meta.id === "string" && meta.id.length > 0;
}

function fallbackReceivedMessageId(event: EveAgentReducerEvent): string {
  const turnId = readTurnId(event);
  if (turnId === null) {
    return "message";
  }
  if (!("data" in event)) {
    return turnId;
  }
  const { data } = event;
  if (typeof data !== "object" || data === null || !("sequence" in data)) {
    return turnId;
  }
  const { sequence } = data;
  return typeof sequence === "number" ? `${turnId}:${sequence}` : turnId;
}

function ensureReceivedMessageMeta(
  event: EveAgentReducerEvent
): EveAgentReducerEvent {
  if (event.type !== "message.received" || hasMetaId(event)) {
    return event;
  }
  const previous =
    "meta" in event && typeof event.meta === "object" && event.meta !== null
      ? event.meta
      : {};
  const at =
    "at" in previous && typeof previous.at === "string"
      ? previous.at
      : "1970-01-01T00:00:00.000Z";
  return {
    ...event,
    meta: { ...previous, at, id: fallbackReceivedMessageId(event) },
  } as EveAgentReducerEvent;
}
