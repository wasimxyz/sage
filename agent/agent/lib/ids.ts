// Tool output names entries `entry-12` and chats `chat-12`. Sage numbers
// entries and chats separately, so a plain 12 could be either. With a prefix,
// a chat id sent to the journal tool, or the reverse, gets an error that names
// the right tool instead of opening the wrong thing.

export type SourceKind = "chat" | "entry";

export interface SourceId {
  id: number;
  kind: SourceKind;
}

const plainId = /^[1-9]\d{0,15}$/;
const prefixedId = /^(entry|chat)-([1-9]\d{0,15})$/;

export function entryId(id: number): string {
  return `entry-${id}`;
}

export function chatId(id: number): string {
  return `chat-${id}`;
}

// Reads an id from a tool call. A bare positive number, or the same number as
// text, reads as an entry: entry results used plain numbers before chats had
// ids, and saved chats still show them. Anything else is null.
export function readId(value: unknown): SourceId | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0
      ? { id: value, kind: "entry" }
      : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim().toLowerCase();
  if (plainId.test(text)) {
    return { id: Number(text), kind: "entry" };
  }
  const match = prefixedId.exec(text);
  if (match === null) {
    return null;
  }
  const [, kind, digits] = match;
  const id = Number(digits);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return { id, kind: kind === "chat" ? "chat" : "entry" };
}

// The label a memory hit gives its source: an entry or chat id, or "you" for
// a memory the user added on the Memories screen.
export function sourceLabel(sourceType: string, sourceId: number): string {
  if (sourceType === "entry") {
    return entryId(sourceId);
  }
  if (sourceType === "conversation") {
    return chatId(sourceId);
  }
  return "you";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelEntry(item: unknown): unknown {
  if (!isRecord(item) || typeof item.id !== "number") {
    return item;
  }
  return { ...item, id: entryId(item.id) };
}

// Sage's journal routes answer with numeric ids. This gives each entry its
// `entry-` id, in a list, in an `entries` list, or in one entry.
export function labelEntryIds(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(labelEntry);
  }
  if (!isRecord(payload)) {
    return payload;
  }
  if (Array.isArray(payload.entries)) {
    return { ...payload, entries: payload.entries.map(labelEntry) };
  }
  return labelEntry(payload);
}

interface AttributesContext {
  session: {
    auth: { current?: { attributes?: Record<string, unknown> } | null };
  };
}

// The saved chat this turn belongs to, from the `x-sage-chat-id` header the
// Chat screen sends, or null for a chat that hasn't saved yet.
export function currentChatId(ctx: AttributesContext): number | null {
  const value = ctx.session.auth.current?.attributes?.chatId;
  if (typeof value !== "string" || !plainId.test(value)) {
    return null;
  }
  return Number(value);
}
