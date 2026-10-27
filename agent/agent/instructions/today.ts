import { defineDynamic, defineInstructions } from "eve/instructions";

import { describeToday, todayFromEnv } from "../lib/when";

// The model cannot know the date, and search_journal reports the dates it
// used against it. A system result at turn.started is fresh every turn and
// stays out of the saved conversation.
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({ content: describeToday(todayFromEnv()) }),
  },
});
