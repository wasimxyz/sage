import { defineTool } from "eve/tools";
import { z } from "zod";

import { readSageJson, sageFetch } from "../lib/sage";

export default defineTool({
  description:
    "Search the user's journal by meaning over per-entry summaries. Returns matching entries with id, title, date, score, and the summary as a snippet; call get_journal_entry with an id to read the full text. Only summarized entries are covered — if a search comes back empty but the user expects a match, suggest Dream in the sidebar.",
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async execute({ query, limit }) {
    const response = await sageFetch("/journal/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: limit ?? 5, query }),
    });
    const payload = await readSageJson(response);
    if (
      payload !== null &&
      typeof payload === "object" &&
      "entries" in payload &&
      Array.isArray(payload.entries)
    ) {
      return payload.entries;
    }
    return payload;
  },
});
