import { defineTool } from "eve/tools";
import { z } from "zod";

import { chatId, labelEntryIds, readId } from "../lib/ids";
import { readSageJson, sageFetch } from "../lib/sage";

export default defineTool({
  description:
    "Fetch one journal entry by id, such as entry-12, and return its decrypted title, date, and body. Use search_journal first when you do not already have an id.",
  async execute({ id }) {
    const source = readId(id);
    if (source === null) {
      throw new Error(
        'Entry ids look like "entry-12". Use one from search_journal.'
      );
    }
    if (source.kind === "chat") {
      throw new Error(
        `${chatId(source.id)} is a chat, not a journal entry. Call get_chat with it.`
      );
    }
    const response = await sageFetch(`/journal/entry/${source.id}`);
    return labelEntryIds(await readSageJson(response));
  },
  inputSchema: z.object({
    id: z
      .union([z.string(), z.number().int().positive()])
      .describe('The entry id from search_journal, such as "entry-12".'),
  }),
});
