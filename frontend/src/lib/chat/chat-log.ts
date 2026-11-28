import {
  type ClientSessionState,
  conversationOf,
  type EveMessage,
  type SessionStreamEvent,
  type TranscriptMessage,
  transcriptOf,
} from "eve/client";

/**
 * A saved chat holds the events of every eve session it has had, in order. A
 * chat moves to a new session when its old one can no longer run, and each
 * `session.started` begins the next one. eve only resumes the last session,
 * so the earlier ones are history: Chat shows them as they were saved.
 */
export interface ChatLog {
  /** Events of the sessions Chat shows but never resumes. */
  history: SessionStreamEvent[];
  /** Events of the session Chat resumes, from its `session.started` on. */
  live: SessionStreamEvent[];
}

const historyIdPrefix = "history-";

function isSessionStart(event: SessionStreamEvent): boolean {
  return event.type === "session.started";
}

/**
 * The events of each session in `events`, in order. Events before the first
 * `session.started` count as one session.
 */
export function splitSessions(
  events: readonly SessionStreamEvent[]
): SessionStreamEvent[][] {
  const sessions: SessionStreamEvent[][] = [];
  let current: SessionStreamEvent[] | null = null;
  for (const event of events) {
    if (current === null || isSessionStart(event)) {
      current = [];
      sessions.push(current);
    }
    current.push(event);
  }
  return sessions;
}

/**
 * Splits a saved chat into history and the session Chat resumes. With no
 * session to resume, every event is history.
 *
 * Chat saves a new session's id before any of its events, at stream index
 * 0, and its events when a turn finishes. A session saved at 0 has none of
 * its events in the chat yet, so every saved event is history, and eve
 * replays the session from its start.
 */
export function splitChatLog(
  events: readonly SessionStreamEvent[],
  session: ClientSessionState | undefined
): ChatLog {
  if (session === undefined || session.streamIndex === 0) {
    return { history: [...events], live: [] };
  }
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && isSessionStart(event)) {
      start = index;
      break;
    }
  }
  if (start <= 0) {
    return { history: [], live: [...events] };
  }
  return { history: events.slice(0, start), live: events.slice(start) };
}

/**
 * The chat's events to save once a resumed session is idle, or null when the
 * saved chat already holds them. eve calls onFinish only for a turn it sees
 * settle, so a turn that settled while no pane was open, or that the app quit
 * during, comes back on resume without one.
 */
export function eventsToSaveAfterResume(
  log: ChatLog,
  liveEvents: readonly SessionStreamEvent[],
  savedLiveCount: number
): SessionStreamEvent[] | null {
  if (liveEvents.length <= savedLiveCount) {
    return null;
  }
  return [...log.history, ...liveEvents];
}

/**
 * The messages of the history sessions. eve's ids repeat from one session to
 * the next, so each id names its session.
 */
export function historyMessages(
  history: readonly SessionStreamEvent[]
): EveMessage[] {
  return splitSessions(history).flatMap((session, index) =>
    conversationOf(session).messages.map((message) => ({
      ...message,
      id: `${historyIdPrefix}${String(index)}:${message.id}`,
    }))
  );
}

/** What was said in the history sessions, as text, oldest first. */
export function historyTranscript(
  history: readonly SessionStreamEvent[]
): TranscriptMessage[] {
  return splitSessions(history).flatMap(
    (session) => transcriptOf(session).messages
  );
}

/** Which history session each event of `history` belongs to. */
function historySessionAt(
  history: readonly SessionStreamEvent[],
  seq: number
): number {
  let session = -1;
  for (let index = 0; index <= seq; index += 1) {
    const event = history[index];
    if (event !== undefined && (index === 0 || isSessionStart(event))) {
      session += 1;
    }
  }
  return session;
}

function dataField(event: SessionStreamEvent, name: string): unknown {
  const { data } = event as { data?: unknown };
  if (typeof data !== "object" || data === null || !(name in data)) {
    return undefined;
  }
  return (data as Record<string, unknown>)[name];
}

/**
 * The id of the message the saved event at `seq` shows in, among `messages`:
 * the history messages, then the live session's. Search hits name an event
 * by its place in the saved chat. Null when that event shows no message.
 */
export function messageIdAtSeq(
  events: readonly SessionStreamEvent[],
  session: ClientSessionState | undefined,
  seq: number,
  messages: readonly EveMessage[]
): string | null {
  const event = events[seq];
  if (event === undefined) {
    return null;
  }
  const { history } = splitChatLog(events, session);
  const prefix =
    seq < history.length
      ? `${historyIdPrefix}${String(historySessionAt(history, seq))}:`
      : null;
  const inSession = (message: EveMessage) =>
    prefix === null
      ? !message.id.startsWith(historyIdPrefix)
      : message.id.startsWith(prefix);
  if (event.type === "delivery.consumed") {
    const deliveryId = dataField(event, "deliveryId");
    if (typeof deliveryId !== "string") {
      return null;
    }
    const id = `${prefix ?? ""}${deliveryId}:user`;
    return messages.some((message) => message.id === id) ? id : null;
  }
  if (event.type === "content.completed") {
    const partId = dataField(event, "partId");
    if (typeof partId !== "string") {
      return null;
    }
    const found = messages.find(
      (message) =>
        inSession(message) &&
        message.parts.some(
          (part) =>
            (part.type === "text" || part.type === "reasoning") &&
            part.id === partId
        )
    );
    return found?.id ?? null;
  }
  return null;
}
