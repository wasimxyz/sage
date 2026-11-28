// Saves a person's past chats into the throwaway Sage through the same bridge
// commands the Chat screen uses, and indexes their messages for `search_chats`.
//
// The bridge is passed in as a function, so a test can answer for it.
//
//   chat.save              the events of one chat, in chunks, as the Chat
//                          screen sends them (`bridge.ts` in the frontend)
//   embeddings.generate    with `chatId`: embeds up to 32 messages, and says
//                          `more` while some are left
//   embeddings.pending     the chats whose message index is due, as `chatIds`
//
// Sage stamps every chat and event with the real clock. The runner stops Sage
// and rewrites those times to each chat's date before Dream reads them (see
// `scripts/eval/chat-times.ts`).

import {
  requireOk,
  resultBoolean,
  resultNumber,
  resultRecord,
  utf8Chunks,
} from "../evals/lib/bridge.ts";
import type { LoadedChat } from "../evals/lib/dataset.ts";

/** One bridge call: the command, its payload, and an id that no other call uses. */
export type BridgeCall = (
  command: string,
  payload: Record<string, unknown>,
  id: string
) => Record<string, unknown>;

/** Smaller than the Chat screen's 32 KiB, so a command file stays small. */
export const CHAT_CHUNK_BYTES = 8000;

/** What the Chat screen saves when a chat is new and Thinking was never set. */
const CONTEXT_LENGTH = 32_768;

/** The Chat screen stops at 64 rounds of 32 messages. A seeded chat is far shorter. */
const MAX_INDEX_ROUNDS = 64;

/** The events of a chat as the Chat screen saves them: a User message and a Sage reply for each exchange. */
export function chatEvents(chat: LoadedChat): string[] {
  let turnNumber = 0;
  return chat.turns.map((turn) => {
    if (turn.role === "user") {
      const turnId = `turn_${turnNumber}`;
      turnNumber += 1;
      return JSON.stringify({
        data: {
          message: turn.text,
          parts: [{ text: turn.text, type: "text" }],
          turnId,
        },
        type: "message.received",
      });
    }
    return JSON.stringify({
      data: { finishReason: "stop", message: turn.text },
      type: "message.completed",
    });
  });
}

/** The `events` text of a save: a JSON array of the chat's events. */
export function chatEventsJson(chat: LoadedChat): string {
  return `[${chatEvents(chat).join(",")}]`;
}

/** The fields of a `chat.save` that are not the events. */
export interface ChatSaveFields {
  contextLength: number;
  eveSessionId: string | null;
  model: string | null;
  streamIndex: number;
  thinking: boolean | null;
  title: string;
}

/**
 * Saves a new chat's events through `chat.save`, in chunks, and returns the id
 * Sage gave it. The first chunk has no id, so Sage makes the row. `label`
 * names the request ids, so a repeat run never matches an old answer, and
 * `name` names the chat in an error.
 */
export function saveChatEvents(
  call: BridgeCall,
  label: string,
  eventsJson: string,
  fields: ChatSaveFields,
  name: string = label
): number {
  const chunks = utf8Chunks(eventsJson, CHAT_CHUNK_BYTES);
  let savedId: number | null = null;
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    const done = index === chunks.length - 1;
    const response = call(
      "chat.save",
      {
        baseSeq: 0,
        chunk,
        contextLength: fields.contextLength,
        done,
        eveSessionId: fields.eveSessionId,
        id: savedId,
        model: fields.model,
        offset,
        streamIndex: fields.streamIndex,
        thinking: fields.thinking,
        title: fields.title,
      },
      `chat-save-${label}-${index}`
    );
    requireOk(response, "chat.save");
    const id = resultNumber(response, "id");
    if (Number.isFinite(id) && id > 0) {
      savedId = id;
    }
    offset += Buffer.byteLength(chunk, "utf8");
  }
  if (savedId === null) {
    throw new Error(`Save did not return an id for ${name}.`);
  }
  return savedId;
}

/**
 * Saves one past chat through `chat.save` and returns the id Sage gave it. It
 * has no eve session, model, or Thinking setting, like a chat from before
 * those columns.
 */
export function saveChat(
  call: BridgeCall,
  label: string,
  chat: LoadedChat
): number {
  return saveChatEvents(
    call,
    `${label}-${chat.index}`,
    chatEventsJson(chat),
    {
      contextLength: CONTEXT_LENGTH,
      eveSessionId: null,
      model: null,
      streamIndex: 0,
      thinking: null,
      title: chat.title,
    },
    `${label} past chat ${chat.index} (${chat.stem})`
  );
}

/** Embeds a chat's messages, a batch at a time, until Sage says none are left. */
export function indexChat(call: BridgeCall, label: string, id: number): void {
  for (let round = 0; round < MAX_INDEX_ROUNDS; round += 1) {
    const response = call(
      "embeddings.generate",
      { chatId: id },
      `chat-index-${label}-${id}-${round}`
    );
    requireOk(response, "embeddings.generate");
    if (!resultBoolean(response, "more")) {
      return;
    }
  }
  throw new Error(
    `Chat ${id} still had messages to embed after ${MAX_INDEX_ROUNDS} rounds.`
  );
}

/** The chats whose message index is due, from `embeddings.pending`. */
export function pendingChatIds(call: BridgeCall, id: string): number[] {
  const response = call("embeddings.pending", {}, id);
  requireOk(response, "embeddings.pending");
  const { chatIds } = resultRecord(response);
  return Array.isArray(chatIds)
    ? chatIds.filter((value): value is number => typeof value === "number")
    : [];
}

/**
 * Saves each past chat, indexes its messages, and checks that none of them is
 * still waiting. Returns the ids in the order of `chats`.
 */
export function seedChats(
  call: BridgeCall,
  label: string,
  chats: readonly LoadedChat[]
): number[] {
  const ids = chats.map((chat) => saveChat(call, label, chat));
  for (const id of ids) {
    indexChat(call, label, id);
  }
  const waiting = new Set(pendingChatIds(call, `chat-pending-${label}`));
  const stuck = ids.filter((id) => waiting.has(id));
  if (stuck.length > 0) {
    throw new Error(
      `Past chat${stuck.length === 1 ? "" : "s"} ${stuck.join(", ")} of ${label} still need${stuck.length === 1 ? "s" : ""} indexing after embeddings.generate. Is the embedding model pulled?`
    );
  }
  return ids;
}
