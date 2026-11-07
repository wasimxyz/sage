/** Each call indexes up to 32 messages, so this covers a 2,048-message chat. */
const maxRounds = 64;

/**
 * Indexes a chat's new messages for Chat's chat search, one batch per call,
 * until Sage says nothing is left. A chat saved again while a batch was out
 * also asks for another call. A failure is thrown and leaves the chat for the
 * next pass, which picks it up from where the index stops.
 */
export async function indexChatMessages(
  id: number,
  generate: (id: number) => Promise<{ more: boolean }>
): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each batch starts after the rows the last one wrote
    const { more } = await generate(id);
    if (!more) {
      return;
    }
  }
}

// What Sage says when Ollama can't embed, from the core's embedding jobs.
const ollamaDownMessages = [
  "Ollama is not running",
  "Ollama did not answer in time",
  "The embedding model is not pulled",
  "Embedding failed",
];

/**
 * True when an indexing error means Ollama can't embed right now, so trying
 * again later can work. Any other error is about the chat itself, such as one
 * deleted while it waited, and trying again won't change it.
 */
export function isOllamaUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return ollamaDownMessages.some((text) => message.includes(text));
}

/**
 * Indexes each chat in turn. Returns false when Ollama stopped the run, so
 * the caller can try again later, and true when every chat was tried. A chat
 * that fails for another reason is skipped, because the next chat can still
 * work.
 */
export async function indexChats(
  ids: readonly number[],
  generate: (id: number) => Promise<{ more: boolean }>
): Promise<boolean> {
  for (const id of ids) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: chats go one at a time so Ollama embeds one batch at a time
      await indexChatMessages(id, generate);
    } catch (error) {
      if (isOllamaUnavailable(error)) {
        return false;
      }
    }
  }
  return true;
}
