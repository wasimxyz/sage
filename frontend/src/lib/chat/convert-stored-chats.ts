import {
  chatConvert,
  chatGet,
  chatUnconvertedIds,
  hasErrorCode,
} from "../../bridge.ts";
import { convertChatEvents } from "./legacy-events.ts";

/** Event format of chats saved before eve 1.0. */
export const legacyEventFormat = 26;

const converting = new Map<number, Promise<void>>();
const convertedListeners = new Set<(id: number) => void>();
let launchPass: Promise<void> = Promise.resolve();

/**
 * Hears of each chat as soon as it is converted. Conversion deletes the
 * chat's message index, so the listener can index the chat again.
 */
export function onChatConverted(listener: (id: number) => void): () => void {
  convertedListeners.add(listener);
  return () => {
    convertedListeners.delete(listener);
  };
}

/**
 * Converts one chat saved before eve 1.0, once. Opening the chat and the
 * pass at launch can ask at the same time; both wait on one conversion.
 */
export function convertStoredChat(id: number): Promise<void> {
  const running = converting.get(id);
  if (running !== undefined) {
    return running;
  }
  const job = (async () => {
    const conversation = await chatGet(id);
    if (conversation.eventFormat !== legacyEventFormat) {
      return;
    }
    const events = convertChatEvents(conversation.events);
    try {
      await chatConvert(id, JSON.stringify(events));
    } catch (error) {
      // The core refuses a chat that is already converted, so it is done.
      if (hasErrorCode(error, "ChatConverted")) {
        return;
      }
      throw error;
    }
    for (const listener of convertedListeners) {
      listener(id);
    }
  })().finally(() => {
    converting.delete(id);
  });
  converting.set(id, job);
  return job;
}

/**
 * Converts every chat saved before eve 1.0, one at a time. A chat that fails
 * keeps its saved events, and the next launch, or opening it, tries again.
 */
export async function convertStoredChats(): Promise<void> {
  const ids = await chatUnconvertedIds();
  for (const id of ids) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one conversion at a time keeps the core's single chunked save free for replies
      await convertStoredChat(id);
    } catch {
      // Left for the next pass.
    }
  }
}

/**
 * Starts the pass at launch once `after` settles, and keeps it so a message
 * sent meanwhile can wait for it. A conversion renumbers a chat's events,
 * and `search_chats` and `get_chat` name messages by those numbers, so no
 * turn should run while one is under way.
 */
export function startStoredChatsPass(after: Promise<void>): Promise<void> {
  launchPass = after.then(() => convertStoredChats()).catch(() => undefined);
  return launchPass;
}

/** Settles once the pass at launch is done, whether or not each chat was. */
export function storedChatsPassDone(): Promise<void> {
  return launchPass;
}
