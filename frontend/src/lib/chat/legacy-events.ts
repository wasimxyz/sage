import type { SessionStreamEvent } from "eve/client";
import { convertLegacyEvents } from "eve/internal/legacy-events";

/**
 * Chats saved before eve 1.0 hold stream version 26 events. eve 1.0 reads
 * only version 27, so Chat converts each saved chat once, with eve's own
 * converter, and saves the result in place.
 *
 * eve converts one session at a time, from its `session.started`. A saved
 * chat can hold several sessions, and chats from early eve releases can lack
 * a `session.started` or the turn and step events around a message. eve
 * leaves out a reply with no step around it, without an error. So when eve
 * cannot convert a session as saved, or its result holds fewer messages than
 * the session, Chat keeps what you and Sage said and converts that instead.
 */

type LegacyEvent = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyEvent(value: unknown): value is LegacyEvent {
  return isRecord(value) && typeof value.type === "string";
}

/** True for an event a version 27 reader wrote: its `meta` has a position. */
export function isConvertedEvent(value: unknown): boolean {
  return (
    isRecord(value) && isRecord(value.meta) && isRecord(value.meta.position)
  );
}

/** True when every saved event is already version 27. */
export function isConvertedLog(events: readonly unknown[]): boolean {
  return events.every(isConvertedEvent);
}

function legacySessions(events: readonly unknown[]): unknown[][] {
  const sessions: unknown[][] = [];
  let current: unknown[] | null = null;
  for (const event of events) {
    if (
      current === null ||
      (isLegacyEvent(event) && event.type === "session.started")
    ) {
      current = [];
      sessions.push(current);
    }
    current.push(event);
  }
  return sessions;
}

function eventAt(event: unknown): string | undefined {
  if (!(isRecord(event) && isRecord(event.meta))) {
    return undefined;
  }
  return typeof event.meta.at === "string" ? event.meta.at : undefined;
}

function firstAt(events: readonly unknown[]): string {
  for (const event of events) {
    const at = eventAt(event);
    if (at !== undefined) {
      return at;
    }
  }
  return new Date(0).toISOString();
}

function legacyMessage(
  event: unknown
): { role: "assistant" | "user"; text: string } | null {
  if (!(isLegacyEvent(event) && isRecord(event.data))) {
    return null;
  }
  const { message } = event.data;
  if (typeof message !== "string" || message.trim().length === 0) {
    return null;
  }
  if (event.type === "message.received") {
    return { role: "user", text: message };
  }
  if (event.type === "message.completed") {
    return { role: "assistant", text: message };
  }
  return null;
}

/**
 * A plain version 26 session with only the session's messages: one turn per
 * message you sent, holding Sage's text after it. Each event keeps its time.
 */
interface TextTurn {
  question: { at: string; text: string } | null;
  replies: { at: string; text: string }[];
}

/** The session's messages as turns: each question, then Sage's text after it. */
function textTurns(events: readonly unknown[]): TextTurn[] {
  const turns: TextTurn[] = [];
  let at = firstAt(events);
  for (const event of events) {
    const message = legacyMessage(event);
    if (message === null) {
      continue;
    }
    at = eventAt(event) ?? at;
    const said = { at, text: message.text };
    const last = turns.at(-1);
    if (message.role === "user") {
      turns.push({ question: said, replies: [] });
    } else if (last === undefined) {
      turns.push({ question: null, replies: [said] });
    } else {
      last.replies.push(said);
    }
  }
  return turns;
}

function turnEvents(turn: TextTurn, index: number, at: string): LegacyEvent[] {
  const ids = { sequence: index, turnId: `turn_${String(index)}` };
  const started = turn.question?.at ?? turn.replies[0]?.at ?? at;
  const out: LegacyEvent[] = [
    { data: ids, meta: { at: started }, type: "turn.started" },
  ];
  if (turn.question !== null) {
    const { text } = turn.question;
    out.push({
      data: { ...ids, message: text, parts: [{ text, type: "text" }] },
      meta: { at: started },
      type: "message.received",
    });
  }
  for (const [stepIndex, reply] of turn.replies.entries()) {
    const step = { ...ids, stepIndex };
    const meta = { at: reply.at };
    out.push(
      { data: step, meta, type: "step.started" },
      {
        data: { ...step, finishReason: "stop", message: reply.text },
        meta,
        type: "message.completed",
      },
      { data: { ...step, finishReason: "stop" }, meta, type: "step.completed" }
    );
  }
  const ended = turn.replies.at(-1)?.at ?? started;
  out.push({ data: ids, meta: { at: ended }, type: "turn.completed" });
  return out;
}

/**
 * A plain version 26 session with only the session's messages: one turn per
 * message you sent, holding Sage's text after it. Each event keeps its time.
 */
function textOnlySession(events: readonly unknown[]): LegacyEvent[] {
  const at = firstAt(events);
  return [
    { data: {}, meta: { at }, type: "session.started" },
    ...textTurns(events).flatMap((turn, index) => turnEvents(turn, index, at)),
  ];
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** User and Sage messages with text among version 27 events. */
function convertedMessageCount(events: readonly SessionStreamEvent[]): number {
  let count = 0;
  for (const event of events) {
    const { data } = event as { data?: unknown };
    if (!isRecord(data)) {
      continue;
    }
    if (event.type === "delivery.consumed" && Array.isArray(data.parts)) {
      const text = data.parts.some(
        (part) => isRecord(part) && part.kind === "text" && hasText(part.text)
      );
      count += text ? 1 : 0;
    } else if (
      event.type === "content.completed" &&
      data.kind === "text" &&
      hasText(data.value)
    ) {
      count += 1;
    }
  }
  return count;
}

function convertSession(events: readonly unknown[]): SessionStreamEvent[] {
  if (isConvertedLog(events)) {
    return events as SessionStreamEvent[];
  }
  const legacy = events.filter((event) => !isConvertedEvent(event));
  const [first] = legacy;
  const prepared =
    isLegacyEvent(first) && first.type === "session.started"
      ? legacy
      : [
          { data: {}, meta: { at: firstAt(legacy) }, type: "session.started" },
          ...legacy,
        ];
  const expected = legacy.filter((event) => legacyMessage(event) !== null);
  try {
    const converted = convertLegacyEvents(prepared);
    if (convertedMessageCount(converted) >= expected.length) {
      return converted;
    }
  } catch {
    // Converted from the messages alone below.
  }
  return convertLegacyEvents(textOnlySession(legacy));
}

/**
 * The saved chat's events as version 27 events, one session at a time.
 * Events that are already version 27 stay as they are.
 */
export function convertChatEvents(
  events: readonly unknown[]
): SessionStreamEvent[] {
  return legacySessions(events).flatMap((session) => convertSession(session));
}
