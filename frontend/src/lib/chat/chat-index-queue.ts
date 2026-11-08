import { indexChats } from "./index-chat.ts";

export interface ChatIndexQueue {
  /**
   * Queues chats to index once `after` settles. A chat that is already
   * waiting or running is left where it is. The answer settles when this run
   * and every run queued before it are done.
   */
  add: (ids: readonly number[], after: Promise<void>) => Promise<void>;
}

/**
 * Chat indexing's own queue. It runs one chat at a time and waits for the
 * entries without holding them up. Each chat leaves the waiting set as soon as
 * it is done, so a later pass can queue it again while the rest of its run
 * goes on. Only Ollama stopping a run calls `onOllamaDown`.
 */
export function createChatIndexQueue(options: {
  generate: (id: number) => Promise<{ more: boolean }>;
  onOllamaDown: () => void;
}): ChatIndexQueue {
  let chain: Promise<void> = Promise.resolve();
  // Each waiting chat knows its run. A run lets go only of chats it still
  // holds, so a pass that queued a chat again is not undone by the run before.
  const waiting = new Map<number, object>();

  return {
    add(ids, after) {
      const fresh = [...new Set(ids)].filter((id) => !waiting.has(id));
      if (fresh.length === 0) {
        return chain;
      }
      const run = {};
      const release = (id: number) => {
        if (waiting.get(id) === run) {
          waiting.delete(id);
        }
      };
      for (const id of fresh) {
        waiting.set(id, run);
      }
      chain = chain
        .then(() => after)
        .then(() => indexChats(fresh, options.generate, release))
        .then((finished) => {
          // Only Ollama being down is worth another pass.
          if (!finished) {
            options.onOllamaDown();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          // Chats the run never reached, as when Ollama stopped it.
          for (const id of fresh) {
            release(id);
          }
        });
      return chain;
    },
  };
}
