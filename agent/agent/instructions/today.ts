import { defineDynamic, defineInstructions } from "eve/instructions";

import { describeToday, todayFromEnv } from "../lib/when";

// The model cannot know the date, and search_journal reports the dates it
// used against it. A system instruction stays out of the saved conversation.
// eve runs this before every model call, and the memo keeps one date per
// turn, so a turn that runs past midnight keeps the date it started with.
export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(["today", ctx.turn?.id ?? null], () =>
    describeToday(todayFromEnv())
  );
  return defineInstructions({ content });
});
