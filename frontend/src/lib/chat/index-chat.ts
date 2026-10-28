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
