import assert from "node:assert/strict";
import test from "node:test";

import { conversationOf, type SessionStreamEvent } from "eve/client";
import { createStreamChecker } from "eve/events";

import { chatSessionEvents, type SavedChatEvent } from "./chat-events.ts";

const at = "2026-11-22T12:00:00.000Z";

const events = chatSessionEvents(
  [
    {
      question: "How have my Sundays changed?",
      reply: "A lot.",
      tool: {
        callId: "call_1",
        input: { query: "Sundays" },
        name: "search_journal",
        output: [{ id: "entry-1" }],
      },
    },
    { question: "And now?", reply: "Better." },
  ],
  { at }
);

/** The stored lines the events came from, in order. */
function storedLines(saved: readonly SavedChatEvent[]) {
  const lines: Omit<SavedChatEvent, "meta">[][] = [];
  for (const event of saved) {
    const { meta, ...fact } = event;
    lines[meta.position.line] ??= [];
    lines[meta.position.line]?.push(fact);
  }
  return lines;
}

test("hand-written chat events pass eve's stream checks", () => {
  const checker = createStreamChecker();
  const lines = storedLines(events);
  for (const [position, facts] of lines.entries()) {
    assert.deepEqual(
      checker.check({ at, facts } as never, position),
      [],
      `line ${String(position)}`
    );
  }
});

test("hand-written chat events render as eve's Chat screen shows them", () => {
  const { messages } = conversationOf(events as SessionStreamEvent[]);
  assert.deepEqual(
    messages.map((message) => [
      message.role,
      ...message.parts.map((part) =>
        part.type === "tool" ? `tool:${part.name}:${part.state}` : part.type
      ),
    ]),
    [
      ["user", "text"],
      ["assistant", "tool:search_journal:completed", "text"],
      ["user", "text"],
      ["assistant", "text"],
    ]
  );
});

test("each line ends once, on its last event", () => {
  for (const line of storedLines(events)) {
    assert.ok(line.length > 0);
  }
  const ends = events.filter((event) => event.meta.endOfLine);
  assert.equal(ends.length, storedLines(events).length);
});
