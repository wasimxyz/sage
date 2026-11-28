import { chatConvert, chatGet, chatUnconvertedIds } from "@/bridge";

import { convertChatEvents } from "./legacy-events.ts";

/** Event format of chats saved before eve 1.0. */
export const legacyEventFormat = 26;

const converting = new Map<number, Promise<void>>();

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
    await chatConvert(id, JSON.stringify(events));
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
