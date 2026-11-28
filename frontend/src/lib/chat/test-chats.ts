/**
 * Saved chats for tests, as eve 0.80 wrote them: stream version 26 events.
 * A recovered chat holds two sessions, each from its `session.started`.
 */

const at = (second: number, minute = 0) =>
  `2026-10-20T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

function legacyTurn(options: {
  minute: number;
  question: string;
  reply: string;
  tool?: { callId: string; name: string };
  turn: number;
}): Record<string, unknown>[] {
  const turnId = `turn_${String(options.turn)}`;
  const meta = (second: number) => ({ at: at(second, options.minute) });
  const turn = { sequence: options.turn, turnId };
  const events: Record<string, unknown>[] = [
    { data: turn, meta: meta(1), type: "turn.started" },
    {
      data: {
        ...turn,
        message: options.question,
        parts: [{ text: options.question, type: "text" }],
      },
      meta: meta(1),
      type: "message.received",
    },
    {
      data: { ...turn, modelId: "qwen3.5:9b", stepIndex: 0 },
      meta: meta(2),
      type: "step.started",
    },
  ];
  if (options.tool !== undefined) {
    const { callId, name } = options.tool;
    events.push(
      {
        data: {
          ...turn,
          finishReason: "tool-calls",
          message: "Let me look.",
          stepIndex: 0,
        },
        meta: meta(3),
        type: "message.completed",
      },
      {
        data: {
          ...turn,
          actions: [{ callId, input: { when: "last week" }, toolName: name }],
          stepIndex: 0,
        },
        meta: meta(3),
        type: "actions.requested",
      },
      {
        data: {
          ...turn,
          result: {
            callId,
            output: { entries: [] },
            status: "completed",
            toolName: name,
          },
        },
        meta: meta(4),
        type: "action.result",
      },
      {
        data: { ...turn, finishReason: "tool-calls", stepIndex: 0 },
        meta: meta(4),
        type: "step.completed",
      },
      {
        data: { ...turn, stepIndex: 1 },
        meta: meta(5),
        type: "step.started",
      }
    );
  }
  const step = options.tool === undefined ? 0 : 1;
  events.push(
    {
      data: {
        ...turn,
        finishReason: "stop",
        message: options.reply,
        stepIndex: step,
      },
      meta: meta(6),
      type: "message.completed",
    },
    {
      data: { ...turn, finishReason: "stop", stepIndex: step },
      meta: meta(6),
      type: "step.completed",
    },
    { data: { turnId }, meta: meta(7), type: "turn.completed" },
    { data: {}, meta: meta(7), type: "session.waiting" }
  );
  return events;
}

function sessionStart(minute: number): Record<string, unknown> {
  return {
    data: { runtime: { eveVersion: "0.80.1" } },
    meta: { at: at(0, minute) },
    type: "session.started",
  };
}

/** One session: a question, a journal search, and an answer. */
export const legacySession: Record<string, unknown>[] = [
  sessionStart(0),
  ...legacyTurn({
    minute: 0,
    question: "How did I sleep last week?",
    reply: "Nothing from last week.",
    tool: { callId: "call_1", name: "search_journal" },
    turn: 0,
  }),
];

/** A chat that moved to a second session, whose turn ids start again. */
export const legacyRecoveredChat: Record<string, unknown>[] = [
  ...legacySession,
  sessionStart(5),
  ...legacyTurn({
    minute: 5,
    question: "And the week before?",
    reply: "You slept well.",
    turn: 0,
  }),
];
