import { chatId } from "./ids.ts";
import { type DateRange, localDayOf } from "./when.ts";

// Who wrote a message, in the words the model reads.
export type Speaker = "sage" | "user";

export interface ChatSearchHit {
  // The local day the message was saved, when Sage knows it.
  date?: string;
  from: Speaker;
  message: number;
  text: string;
}

export interface ChatSearchChat {
  // The local days the chat was active: one day, or "from to to".
  active: string;
  hits: ChatSearchHit[];
  id: string;
  title: string;
}

export interface ChatListItem {
  active: string;
  // Dream's summary, or the start of the first message when there is none.
  firstMessage?: string;
  id: string;
  summary?: string;
  title: string;
}

export interface ChatWindowMessage {
  cut?: true;
  date?: string;
  from: Speaker;
  message: number;
  text: string;
}

export interface ChatResult<Item> {
  chats: Item[];
  note?: string;
  range?: DateRange;
  today?: string;
}

export interface ChatWindow {
  active: string;
  id: string;
  messages: ChatWindowMessage[];
  note?: string;
  summary?: string;
  title: string;
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return Reflect.get(value, key);
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown, key: string): unknown[] {
  const items = field(value, key);
  return Array.isArray(items) ? items : [];
}

function speaker(role: unknown): Speaker {
  return role === "assistant" ? "sage" : "user";
}

// "2026-10-20", or "2026-10-19 to 2026-10-21" for a chat that ran over days.
function activeDays(first: unknown, last: unknown): string {
  const from = localDayOf(text(first));
  const to = localDayOf(text(last));
  if (from === null || to === null) {
    return from ?? to ?? "";
  }
  return from === to ? from : `${from} to ${to}`;
}

function dateOf(value: unknown): { date?: string } {
  const day = typeof value === "string" ? localDayOf(value) : null;
  return day === null ? {} : { date: day };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function rangeWords(range: DateRange): string {
  return range.from === range.to
    ? `on ${range.from}`
    : `from ${range.from} to ${range.to}`;
}

function withContext<Item>(
  chats: Item[],
  notes: string[],
  range: DateRange | null,
  today: string
): ChatResult<Item> {
  return {
    chats,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    ...(range === null ? {} : { range, today }),
  };
}

// Groups the server's hits by chat, keeping the order of each chat's best hit.
function groupHits(payload: unknown): ChatSearchChat[] {
  const chats: ChatSearchChat[] = [];
  const byId = new Map<number, ChatSearchChat>();
  for (const hit of list(payload, "hits")) {
    const id = field(hit, "chatId");
    const message = field(hit, "message");
    if (typeof id !== "number" || typeof message !== "number") {
      continue;
    }
    let chat = byId.get(id);
    if (chat === undefined) {
      chat = {
        active: activeDays(
          field(hit, "chatCreatedAt"),
          field(hit, "chatUpdatedAt")
        ),
        hits: [],
        id: chatId(id),
        title: text(field(hit, "title")),
      };
      byId.set(id, chat);
      chats.push(chat);
    }
    chat.hits.push({
      ...dateOf(field(hit, "savedAt")),
      from: speaker(field(hit, "role")),
      message,
      text: text(field(hit, "snippet")),
    });
  }
  return chats;
}

// A search of earlier chats by meaning, inside `range` when there is one.
// The note says in plain words what the hits alone don't.
export function shapeChatSearch(input: {
  payload: unknown;
  range: DateRange | null;
  today: string;
}): ChatResult<ChatSearchChat> {
  const { payload, range, today } = input;
  const chats = groupHits(payload);
  const shown = chats.reduce((count, chat) => count + chat.hits.length, 0);
  const matched = whole(field(payload, "matched"));
  const belowCutoff = whole(field(payload, "belowCutoff"));
  const unreadable = whole(field(payload, "unreadable"));
  const unindexed = whole(field(payload, "unindexed"));
  const where = range === null ? "" : ` ${rangeWords(range)}`;

  const notes: string[] = [];
  if (shown === 0 && belowCutoff > 0) {
    notes.push(
      range === null
        ? `${plural(belowCutoff, "message", "messages")} didn't match closely enough to show. Try other words.`
        : `${plural(belowCutoff, "message", "messages")}${where} didn't match closely enough to show. Leave out query to list the chats from then.`
    );
  }
  if (matched > shown) {
    notes.push(
      `Showing ${shown} of ${matched} matching messages, at most 2 from each chat.`
    );
  }
  if (unindexed > 0) {
    const one = unindexed === 1;
    notes.push(
      `${plural(unindexed, "chat has", "chats have")} messages this search can't see yet. Dream in the sidebar adds ${one ? "it" : "them"}.`
    );
  }
  if (unreadable > 0) {
    notes.push(
      `${plural(unreadable, "message was", "messages were")} indexed with another embedding model, so this search can't compare ${unreadable === 1 ? "it" : "them"}.`
    );
  }
  if (shown === 0 && notes.length === 0) {
    notes.push(`No earlier chat${where} matches.`);
  }
  return withContext(chats, notes, range, today);
}

// The chats active during `range`, with no query.
export function shapeChatList(input: {
  payload: unknown;
  range: DateRange;
  today: string;
}): ChatResult<ChatListItem> {
  const { payload, range, today } = input;
  const chats: ChatListItem[] = [];
  let unsummarized = 0;
  for (const item of list(payload, "chats")) {
    const id = field(item, "chatId");
    if (typeof id !== "number") {
      continue;
    }
    const snippet = text(field(item, "snippet"));
    const summarized = field(item, "summarized") === true;
    if (!summarized) {
      unsummarized += 1;
    }
    chats.push({
      active: activeDays(field(item, "firstAt"), field(item, "lastAt")),
      id: chatId(id),
      title: text(field(item, "title")),
      ...(summarized ? { summary: snippet } : { firstMessage: snippet }),
    });
  }

  const total = whole(field(payload, "total"));
  const notes: string[] = [];
  if (total === 0) {
    notes.push(`No chats ${rangeWords(range)}.`);
  } else if (total > chats.length) {
    notes.push(
      `Showing ${chats.length} of ${total} chats, picked evenly in date order. Add a query or narrow when to see more.`
    );
  }
  if (unsummarized > 0) {
    notes.push(
      `${plural(unsummarized, "chat has", "chats have")} no summary yet, so ${unsummarized === 1 ? "it shows its" : "they show their"} first message. Dream in the sidebar adds summaries.`
    );
  }
  return withContext(chats, notes, range, today);
}

// Says how many messages a window leaves out, and which message number reads
// more. Message numbers have gaps, so only a number shown is sure to be a
// message. The first and last shown lead to the messages beside them.
function leftOutNote(before: number, after: number): string | null {
  if (before === 0 && after === 0) {
    return null;
  }
  const parts = [
    before > 0 ? plural(before, "earlier message", "earlier messages") : "",
    after > 0 ? plural(after, "later message", "later messages") : "",
  ].filter((part) => part.length > 0);
  let reach = "the first or last message number shown";
  if (after === 0) {
    reach = "the first message number shown";
  } else if (before === 0) {
    reach = "the last message number shown";
  }
  return `${parts.join(" and ")} ${before + after === 1 ? "isn't" : "aren't"} shown. To read more, call get_chat with ${reach}.`;
}

// One part of a chat: a few messages around a hit, or its last few.
export function shapeChatWindow(payload: unknown): ChatWindow {
  const id = field(payload, "chatId");
  const messages: ChatWindowMessage[] = [];
  let cut = false;
  for (const item of list(payload, "messages")) {
    const message = field(item, "message");
    if (typeof message !== "number") {
      continue;
    }
    const wasCut = field(item, "cut") === true;
    cut ||= wasCut;
    messages.push({
      ...dateOf(field(item, "savedAt")),
      from: speaker(field(item, "role")),
      message,
      text: text(field(item, "text")),
      ...(wasCut ? { cut: true as const } : {}),
    });
  }

  const notes: string[] = [];
  const leftOut = leftOutNote(
    whole(field(payload, "before")),
    whole(field(payload, "after"))
  );
  if (leftOut !== null) {
    notes.push(leftOut);
  }
  if (cut) {
    notes.push("Long messages are cut short.");
  }
  const summary = field(payload, "summary");
  return {
    active: activeDays(
      field(payload, "createdAt"),
      field(payload, "updatedAt")
    ),
    id: typeof id === "number" ? chatId(id) : "",
    messages,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    ...(typeof summary === "string" && summary.length > 0 ? { summary } : {}),
    title: text(field(payload, "title")),
  };
}

// What to tell the model when `get_chat` finds nothing. Sage answers 404 for a
// chat that is gone and for a message number that is not a message of a chat
// that is there. Message numbers have gaps, so it says which one happened.
export function missingChatText(
  body: unknown,
  id: number,
  message: number | undefined
): string {
  if (message !== undefined && field(body, "error") === "message_not_found") {
    return `${chatId(id)} has no message ${message}. Use a message number shown by search_chats or an earlier get_chat, or leave message out to read the end of the chat.`;
  }
  return `No chat has the id ${chatId(id)}.`;
}
