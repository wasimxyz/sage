// The chat `make screenshots` shows. It is written by hand, so the shot is the
// same on every run and needs no model. The entries it cites come from
// scripts/seed. They get their ids when the script saves them, so the search
// card opens the right entries.

export interface ChatSource {
  date: string;
  id: number;
  title: string;
}

export interface ScreenshotChat {
  contextLength: number;
  events: unknown[];
  model: string;
  thinking: boolean;
  title: string;
}

export const chatTitle = "Sundays since the move";
export const chatQuestion = "How have my Sundays changed since I moved?";
export const chatSearchQuery = "Sundays";
// The model the saved chat names. Settings > Models shows what is installed.
export const chatModel = "qwen3.5:9b";
const chatContextLength = 32_768;

/** The seed files the search card lists, in the order it lists them. */
export const chatSourceFiles = [
  "13-sunday.md",
  "17-first-sunday-call.md",
  "25-sunday-again.md",
] as const;

export const chatAnswer = [
  "They changed a lot in about a month.",
  "",
  "- In **Sunday**, you didn't say a word out loud until 4pm, when the grocery clerk asked if you wanted a bag. You missed dinner at Elena's and the table you built.",
  "- In **First Sunday call**, you lined your entries up and saw that Sunday was your hardest day. Jason in the morning and your mom in the evening held the two ends. The middle was still open.",
  '- In **Sunday, again**, you talked to people all day. You argued with Jason about the slideshow, drew tables at the coffee place, and said yes to the farmers market with Dev and Sam instead of "I have plans."',
  "",
  "You also wrote that you don't want it to turn into a postcard. It's still quiet most nights. What seems to help most is saying yes before you talk yourself out of it.",
  "",
  "Do you want to think about what could fill the middle of next Sunday?",
].join("\n");

const turnId = "turn_screenshot";
const callId = "call_screenshot_search";

/**
 * The eve events of one finished turn: the question, one journal search with
 * its result, and the answer. Each event has `meta.id`, which eve's reducer
 * needs to replay a stored chat.
 */
export function screenshotChatEvents(
  sources: readonly ChatSource[],
  now: Date
): unknown[] {
  const at = now.toISOString();
  const bodies: { data: Record<string, unknown>; type: string }[] = [
    { data: { turnId }, type: "turn.started" },
    { data: { message: chatQuestion, turnId }, type: "message.received" },
    { data: { stepIndex: 0, turnId }, type: "step.started" },
    {
      data: {
        actions: [
          {
            callId,
            input: { query: chatSearchQuery },
            kind: "tool-call",
            toolName: "search_journal",
          },
        ],
        stepIndex: 0,
        turnId,
      },
      type: "actions.requested",
    },
    {
      data: {
        result: {
          callId,
          kind: "tool-result",
          output: sources.map((source) => ({
            date: source.date,
            id: `entry-${source.id}`,
            title: source.title,
          })),
          toolName: "search_journal",
        },
        status: "completed",
        stepIndex: 0,
        turnId,
      },
      type: "action.result",
    },
    {
      data: { finishReason: "tool-calls", stepIndex: 0, turnId },
      type: "step.completed",
    },
    { data: { stepIndex: 1, turnId }, type: "step.started" },
    {
      data: { finishReason: "stop", message: chatAnswer, stepIndex: 1, turnId },
      type: "message.completed",
    },
    {
      data: { finishReason: "stop", stepIndex: 1, turnId },
      type: "step.completed",
    },
    { data: { turnId }, type: "turn.completed" },
  ];
  return bodies.map((body, sequence) => ({
    data: { ...body.data, sequence },
    meta: { at, id: `evt_screenshot_${String(sequence).padStart(3, "0")}` },
    type: body.type,
  }));
}

export function screenshotChat(
  sources: readonly ChatSource[],
  now: Date
): ScreenshotChat {
  return {
    contextLength: chatContextLength,
    events: screenshotChatEvents(sources, now),
    model: chatModel,
    thinking: false,
    title: chatTitle,
  };
}
