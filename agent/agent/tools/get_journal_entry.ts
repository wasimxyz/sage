import { defineTool } from "eve/tools";
import { z } from "zod";

import { readSageJson, sageFetch } from "../lib/sage";

export default defineTool({
  description:
    "Fetch one journal entry by id and return its decrypted title, date, and body. Use search_journal first when you do not already have an id.",
  inputSchema: z.object({
    id: z.number().int().positive(),
  }),
  async execute({ id }) {
    const response = await sageFetch(`/journal/entry/${id}`);
    return await readSageJson(response);
  },
});
