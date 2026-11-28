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
 * cannot convert a session as saved, or its result holds fewer of your
 * messages or fewer of Sage's than the session, Chat keeps what you and Sage
 * said and converts that instead.
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

type Role = "assistant" | "user";

/** The text of a version 26 message's parts, as eve's converter reads it. */
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("\n");
}

function legacyMessage(event: unknown): { role: Role; text: string } | null {
  if (!(isLegacyEvent(event) && isRecord(event.data))) {
    return null;
  }
  const { message, parts } = event.data;
  const said = typeof message === "string" ? message : "";
  if (event.type === "message.received") {
    // eve reads what you sent from its parts, and Chat saved the same text
    // in both. Use whichever holds text.
    const fromParts = partsText(parts);
    const text = fromParts.trim().length > 0 ? fromParts : said;
    return text.trim().length > 0 ? { role: "user", text } : null;
  }
  if (event.type === "message.completed" && said.trim().length > 0) {
    return { role: "assistant", text: said };
  }
  return null;
}

/** The model a version 26 step named, if any. */
function legacyModelId(event: unknown): string | undefined {
  if (
    !(
      isLegacyEvent(event) &&
      event.type === "step.started" &&
      isRecord(event.data)
    )
  ) {
    return undefined;
  }
  const { modelId } = event.data;
  return typeof modelId === "string" && modelId.length > 0
    ? modelId
    : undefined;
}

/**
 * A plain version 26 session with only the session's messages: one turn per
 * message you sent, holding Sage's text after it. Each event keeps its time.
 */
interface TextTurn {
  question: { at: string; text: string } | null;
  replies: { at: string; modelId: string | undefined; text: string }[];
}

/**
 * The session's messages as turns: each question, then Sage's text after it.
 * Each reply keeps the model the step before it named.
 */
function textTurns(events: readonly unknown[]): TextTurn[] {
  const turns: TextTurn[] = [];
  let at = firstAt(events);
  let modelId: string | undefined;
  for (const event of events) {
    modelId = legacyModelId(event) ?? modelId;
    const message = legacyMessage(event);
    if (message === null) {
      continue;
    }
    at = eventAt(event) ?? at;
    const last = turns.at(-1);
    if (message.role === "user") {
      turns.push({ question: { at, text: message.text }, replies: [] });
      continue;
    }
    const reply = { at, modelId, text: message.text };
    if (last === undefined) {
      turns.push({ question: null, replies: [reply] });
    } else {
      last.replies.push(reply);
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
    const model = reply.modelId === undefined ? {} : { modelId: reply.modelId };
    out.push(
      { data: { ...step, ...model }, meta, type: "step.started" },
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

type RoleCounts = Record<Role, number>;

/** Your messages and Sage's with text among version 27 events. */
function convertedMessageCounts(
  events: readonly SessionStreamEvent[]
): RoleCounts {
  const counts: RoleCounts = { assistant: 0, user: 0 };
  for (const event of events) {
    const { data } = event as { data?: unknown };
    if (!isRecord(data)) {
      continue;
    }
    if (event.type === "delivery.consumed" && Array.isArray(data.parts)) {
      const text = data.parts.some(
        (part) => isRecord(part) && part.kind === "text" && hasText(part.text)
      );
      counts.user += text ? 1 : 0;
    } else if (
      event.type === "content.completed" &&
      data.kind === "text" &&
      hasText(data.value)
    ) {
      counts.assistant += 1;
    }
  }
  return counts;
}

/** Your messages and Sage's with text among version 26 events. */
function legacyMessageCounts(events: readonly unknown[]): RoleCounts {
  const counts: RoleCounts = { assistant: 0, user: 0 };
  for (const event of events) {
    const message = legacyMessage(event);
    if (message !== null) {
      counts[message.role] += 1;
    }
  }
  return counts;
}

function turnIdOf(event: LegacyEvent): unknown {
  return isRecord(event.data) ? event.data.turnId : undefined;
}

const turnEnds = new Set(["turn.cancelled", "turn.completed", "turn.failed"]);

/**
 * Gives each event that has no time the time of the event before it, or of
 * the session's first event with one. eve's converter keeps each event's
 * time, and Sage stamps each saved row with it, so a search by time can
 * place the message.
 */
function withTimes(events: readonly unknown[]): unknown[] {
  let at = events.map(eventAt).find((value) => value !== undefined);
  if (at === undefined) {
    return [...events];
  }
  return events.map((event) => {
    const own = eventAt(event);
    if (own !== undefined) {
      at = own;
      return event;
    }
    if (!isRecord(event)) {
      return event;
    }
    const meta = isRecord(event.meta) ? event.meta : {};
    return { ...event, meta: { ...meta, at } };
  });
}

/**
 * Leaves out a step that started and showed nothing before its turn moved
 * on or the session stopped, as when the app quit during a reply. eve would
 * draw it as an empty Sage message.
 */
function withoutEmptySteps(events: readonly unknown[]): unknown[] {
  return events.filter((event, index) => {
    if (!(isLegacyEvent(event) && event.type === "step.started")) {
      return true;
    }
    const turnId = turnIdOf(event);
    const next = events
      .slice(index + 1)
      .find((later) => isLegacyEvent(later) && turnIdOf(later) === turnId);
    return (
      isLegacyEvent(next) &&
      next.type !== "step.started" &&
      !next.type.startsWith("turn.")
    );
  });
}

/**
 * Ends each turn the session never ended, as stopped. The session will not
 * run again, so the turn is over.
 */
function withTurnsEnded(events: readonly unknown[]): unknown[] {
  const open = new Set<string>();
  let at = new Date(0).toISOString();
  for (const event of events) {
    at = eventAt(event) ?? at;
    if (!isLegacyEvent(event)) {
      continue;
    }
    const turnId = turnIdOf(event);
    if (typeof turnId !== "string") {
      continue;
    }
    if (event.type === "turn.started") {
      open.add(turnId);
    } else if (turnEnds.has(event.type)) {
      open.delete(turnId);
    }
  }
  return [
    ...events,
    ...[...open].map((turnId) => ({
      data: { turnId },
      meta: { at },
      type: "turn.cancelled",
    })),
  ];
}

function convertSession(events: readonly unknown[]): SessionStreamEvent[] {
  if (isConvertedLog(events)) {
    return events as SessionStreamEvent[];
  }
  const legacy = withTimes(events.filter((event) => !isConvertedEvent(event)));
  const [first] = legacy;
  const ended = withTurnsEnded(withoutEmptySteps(legacy));
  const prepared =
    isLegacyEvent(first) && first.type === "session.started"
      ? ended
      : [
          { data: {}, meta: { at: firstAt(legacy) }, type: "session.started" },
          ...ended,
        ];
  const expected = legacyMessageCounts(legacy);
  try {
    const converted = convertLegacyEvents(prepared);
    // Counted per role, so an extra message of yours cannot hide a reply
    // eve left out.
    const counts = convertedMessageCounts(converted);
    if (
      counts.user >= expected.user &&
      counts.assistant >= expected.assistant
    ) {
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
