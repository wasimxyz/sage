import { defineTool } from "eve/tools";
import { z } from "zod";

import { readSageJson, sageFetch } from "../lib/sage";
import { shapeRangeResult } from "../lib/search-result";
import type { DateRange } from "../lib/when";
import { resolveWhen, todayFromEnv } from "../lib/when";

const searchLimit = 5;
const listLimit = 10;

function rangeFor(phrase: string, today: string): DateRange | null {
  if (phrase.length === 0) {
    return null;
  }
  const resolved = resolveWhen(phrase, today);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  return resolved.range;
}

export default defineTool({
  description:
    'Find journal entries by meaning, by time, or both. Pass query to search by meaning. Pass when to pick a time: copy the user\'s own words, such as "last week", "in March", or "recently". With when and no query, you get what they wrote in that time. Each entry has an id, title, date, and snippet; call get_journal_entry with an id to read one in full. Search by meaning covers only entries Dream has summarized — if a search comes back empty but the user expects a match, suggest Dream in the sidebar.',
  async execute({ limit, query, when }) {
    const text = query?.trim() ?? "";
    const today = todayFromEnv();
    const range = rangeFor(when?.trim() ?? "", today);
    if (text.length === 0 && range === null) {
      throw new Error(
        "Pass query to search by meaning, when to pick a time, or both."
      );
    }
    const response = await sageFetch("/journal/search", {
      body: JSON.stringify({
        limit: limit ?? (text.length > 0 ? searchLimit : listLimit),
        ...(text.length > 0 ? { query: text } : {}),
        ...(range === null ? {} : { from: range.from, to: range.to }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await readSageJson(response);
    if (range !== null) {
      return shapeRangeResult({
        hasQuery: text.length > 0,
        payload,
        range,
        today,
      });
    }
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
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("How many entries to return."),
    query: z
      .string()
      .optional()
      .describe(
        "What to look for, by meaning. Leave out to list what the user wrote in the time."
      ),
    when: z
      .string()
      .optional()
      .describe(
        'The time to look at, in the user\'s own words, such as "last week" or "in March". Dates also work: YYYY-MM-DD..YYYY-MM-DD.'
      ),
  }),
});
