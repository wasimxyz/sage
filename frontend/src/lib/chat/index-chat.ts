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
  "Local AI is not running",
  "Local AI did not answer in time",
  "The embedding model is not downloaded",
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

// What Sage says when a delete in Settings > Data ran while a batch was out.
// The batch is dropped, and the chat still needs indexing.
const dataDeletedMessage = "Journal data was deleted";

/**
 * True when a delete in Settings > Data ran while this call was out. Sage
 * dropped the batch and left the chat as it was, so calling again picks it up.
 */
export function isDataDeleted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes(dataDeletedMessage);
}

/** A chat is tried this many times when deletes keep landing on its calls. */
const maxAttempts = 3;

type ChatOutcome = "indexed" | "ollama-down" | "skipped";

async function indexChat(
  id: number,
  generate: (id: number) => Promise<{ more: boolean }>
): Promise<ChatOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a retry starts after the call it repeats has failed
      await indexChatMessages(id, generate);
      return "indexed";
    } catch (error) {
      if (isOllamaUnavailable(error)) {
        return "ollama-down";
      }
      if (!isDataDeleted(error)) {
        return "skipped";
      }
    }
  }
  return "skipped";
}

/**
 * Indexes each chat in turn. Returns false when Ollama stopped the run, so
 * the caller can try again later, and true when every chat was tried. A chat
 * that fails for another reason is skipped, because the next chat can still
 * work. A chat whose call a data delete cut off is tried again, since it is
 * still due and no later pass is guaranteed to list it. `onSettled` hears of
 * each chat as soon as it is done, whatever the result.
 */
export async function indexChats(
  ids: readonly number[],
  generate: (id: number) => Promise<{ more: boolean }>,
  onSettled?: (id: number) => void
): Promise<boolean> {
  for (const id of ids) {
    // biome-ignore lint/performance/noAwaitInLoops: chats go one at a time so Ollama embeds one batch at a time
    const outcome = await indexChat(id, generate);
    onSettled?.(id);
    if (outcome === "ollama-down") {
      return false;
    }
  }
  return true;
}
