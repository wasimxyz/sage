import { parseCalendarDate } from "../format-date.ts";

const prefixedChatId = /^chat-([1-9]\d{0,15})$/;
const calendarDay = /^\d{4}-\d{2}-\d{2}/;

/** One past chat a `search_chats` call found, as a row of its card. */
export interface ChatToolHit {
  /** The day to show: the hit's own day, or the first day the chat ran. */
  date: string | null;
  id: number;
  /** The message to open the chat at, or null to open it at the end. */
  seq: number | null;
  title: string;
}

/** The chat a `get_chat` call read, and the message it read around. */
export interface ChatToolRead {
  date: string | null;
  id: number;
  seq: number | null;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The chat id in a tool result, `chat-12`, or null. */
export function readChatId(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = prefixedChatId.exec(value);
  return match === null ? null : Number(match[1]);
}

function messageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// `active` is one day, or "from to to". A card shows the first.
function firstDay(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const day = calendarDay.exec(value)?.[0] ?? null;
  return day !== null && parseCalendarDate(day) !== null ? day : null;
}

/**
 * The chats a `search_chats` call found, in order. A search by meaning opens
 * each chat at its best hit. A search by time alone has no hits and opens a
 * chat at its end. Null when the result is not one the card knows.
 */
export function chatSearchHits(output: unknown): ChatToolHit[] | null {
  if (!(isRecord(output) && Array.isArray(output.chats))) {
    return null;
  }
  const hits: ChatToolHit[] = [];
  for (const chat of output.chats) {
    const id = isRecord(chat) ? readChatId(chat.id) : null;
    if (!(isRecord(chat) && id !== null && typeof chat.title === "string")) {
      return null;
    }
    const best =
      Array.isArray(chat.hits) && isRecord(chat.hits[0]) ? chat.hits[0] : null;
    hits.push({
      date: firstDay(best?.date) ?? firstDay(chat.active),
      id,
      seq: messageNumber(best?.message),
      title: chat.title,
    });
  }
  return hits;
}

/** The chat a `get_chat` call read, or null when it is not one. */
export function chatReadOutput(
  input: unknown,
  output: unknown
): ChatToolRead | null {
  const id = isRecord(output) ? readChatId(output.id) : null;
  if (!(isRecord(output) && id !== null && typeof output.title === "string")) {
    return null;
  }
  const seq = isRecord(input) ? messageNumber(input.message) : null;
  const read = Array.isArray(output.messages)
    ? output.messages.find(
        (message) => isRecord(message) && message.message === seq
      )
    : undefined;
  return {
    date:
      (isRecord(read) ? firstDay(read.date) : null) ?? firstDay(output.active),
    id,
    seq,
    title: output.title,
  };
}
