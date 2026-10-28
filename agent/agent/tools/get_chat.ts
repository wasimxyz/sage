import { defineTool } from "eve/tools";
import { z } from "zod";

import { shapeChatWindow } from "../lib/chat-result";
import { chatId, entryId, readId } from "../lib/ids";
import { readSageJson, sageFetch } from "../lib/sage";

const entryPrefix = /^\s*entry-/i;

export default defineTool({
  description:
    "Read part of an earlier chat by its id, such as chat-12. Pass the message number from a search_chats hit to read the messages around it. Leave out message to get the chat's summary and its last messages. Use search_chats first when you don't already have an id.",
  async execute({ id, message }) {
    const source = readId(id);
    // A plain number may be a chat id that lost its prefix, so only an id
    // that says `entry-` is sent to the journal tool.
    if (source?.kind === "entry" && entryPrefix.test(String(id))) {
      throw new Error(
        `${entryId(source.id)} is a journal entry, not a chat. Call get_journal_entry with it.`
      );
    }
    if (source?.kind !== "chat") {
      throw new Error(
        'Chat ids look like "chat-12". Use one from search_chats.'
      );
    }
    const path =
      message === undefined
        ? `/chats/${source.id}`
        : `/chats/${source.id}?message=${message}`;
    const response = await sageFetch(path);
    const payload = await readSageJson(
      response,
      message === undefined
        ? `No chat has the id ${chatId(source.id)}.`
        : `${chatId(source.id)} has no message ${message}. Use a message number from search_chats, or leave it out.`
    );
    return shapeChatWindow(payload);
  },
  inputSchema: z.object({
    id: z
      .union([z.string(), z.number()])
      .describe('The chat id from search_chats, such as "chat-12".'),
    message: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The message number of a search_chats hit to read around."),
  }),
});
