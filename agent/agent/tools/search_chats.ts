import { defineTool } from "eve/tools";
import { z } from "zod";

import { shapeChatList, shapeChatSearch } from "../lib/chat-result";
import { currentChatId } from "../lib/ids";
import { readSageJson, sageFetch } from "../lib/sage";
import { instantsFromRange, rangeFromWhen, todayFromEnv } from "../lib/when";

const searchLimit = 5;
const listLimit = 10;

export default defineTool({
  description:
    'Find what was said in earlier chats with Sage, by meaning, by time, or both. Use it when the user points back to an earlier talk, such as "last time", "you told me before", or "we talked about", or asks what you\'ve discussed. Pass query to search by meaning; it searches what the user said and what Sage replied. Pass when to pick a time: copy the user\'s own words, such as "last week". With when and no query, you get the chats from that time. Each chat has an id such as chat-12, and each hit has a message number; call get_chat with both to read around it. The chat you are in is left out.',
  async execute({ limit, query, when }, ctx) {
    const text = query?.trim() ?? "";
    const today = todayFromEnv();
    const range = rangeFromWhen(when ?? "", today);
    if (text.length === 0 && range === null) {
      throw new Error(
        "Pass query to search by meaning, when to pick a time, or both."
      );
    }
    const exclude = currentChatId(ctx);
    const response = await sageFetch("/chats/search", {
      body: JSON.stringify({
        limit: limit ?? (text.length > 0 ? searchLimit : listLimit),
        ...(text.length > 0 ? { query: text } : {}),
        ...(range === null ? {} : instantsFromRange(range)),
        ...(exclude === null ? {} : { exclude }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await readSageJson(response);
    if (text.length === 0 && range !== null) {
      return shapeChatList({ payload, range, today });
    }
    return shapeChatSearch({ payload, range, today });
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("How many messages, or chats with no query, to return."),
    query: z
      .string()
      .optional()
      .describe(
        "What to look for, by meaning. Leave out to list the chats from the time."
      ),
    when: z
      .string()
      .optional()
      .describe(
        'The time to look at, in the user\'s own words, such as "last week" or "in March". Dates also work: YYYY-MM-DD..YYYY-MM-DD.'
      ),
  }),
});
