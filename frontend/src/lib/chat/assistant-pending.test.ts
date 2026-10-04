import assert from "node:assert/strict";
import test from "node:test";

import type { EveMessage, EveMessagePart } from "eve/client";

import {
  assistantPartIsVisible,
  shouldShowAssistantPending,
} from "./assistant-pending.ts";

function message(
  role: EveMessage["role"],
  parts: EveMessagePart[],
  id = `${role}`
): EveMessage {
  return { id, parts, role };
}

const user = message("user", [{ text: "Hello", type: "text" }], "turn_0:user");
const emptyAssistant = message(
  "assistant",
  [{ type: "step-start" }],
  "turn_0:assistant"
);
const emptyReasoning = message(
  "assistant",
  [{ state: "streaming", text: "   ", type: "reasoning" }],
  "turn_0:assistant"
);
const emptyText = message(
  "assistant",
  [{ state: "streaming", text: "", type: "text" }],
  "turn_0:assistant"
);
const reasoning = message(
  "assistant",
  [{ state: "streaming", text: "Considering the week.", type: "reasoning" }],
  "turn_0:assistant"
);
const reply = message(
  "assistant",
  [{ state: "streaming", text: "Hi.", type: "text" }],
  "turn_0:assistant"
);
const tool = message(
  "assistant",
  [
    {
      input: {},
      state: "input-available",
      toolCallId: "call_1",
      toolName: "search_journal",
      type: "dynamic-tool",
    },
  ],
  "turn_0:assistant"
);

test("assistantPartIsVisible treats empty text and blank reasoning as hidden", () => {
  assert.equal(assistantPartIsVisible({ text: "", type: "text" }), false);
  assert.equal(
    assistantPartIsVisible({ text: "   ", type: "reasoning" }),
    false
  );
  assert.equal(assistantPartIsVisible({ text: "Hi.", type: "text" }), true);
  assert.equal(assistantPartIsVisible({ type: "step-start" }), false);
});

test("shouldShowAssistantPending is true after send before the first token", () => {
  assert.equal(shouldShowAssistantPending([user], "submitted"), true);
  assert.equal(
    shouldShowAssistantPending([user, emptyAssistant], "streaming"),
    true
  );
  assert.equal(
    shouldShowAssistantPending([user, emptyReasoning], "streaming"),
    true
  );
  assert.equal(
    shouldShowAssistantPending([user, emptyText], "streaming"),
    true
  );
});

test("shouldShowAssistantPending hides once reasoning, text, or a tool appears", () => {
  assert.equal(
    shouldShowAssistantPending([user, reasoning], "streaming"),
    false
  );
  assert.equal(shouldShowAssistantPending([user, reply], "streaming"), false);
  assert.equal(shouldShowAssistantPending([user, tool], "streaming"), false);
});

test("shouldShowAssistantPending stays off when the turn is idle or resuming", () => {
  assert.equal(shouldShowAssistantPending([user], "ready"), false);
  assert.equal(shouldShowAssistantPending([user], "resuming"), false);
  assert.equal(shouldShowAssistantPending([user], "error"), false);
  assert.equal(shouldShowAssistantPending([], "submitted"), false);
});

test("shouldShowAssistantPending shows again on the next user turn", () => {
  const prior = message(
    "assistant",
    [{ state: "done", text: "Earlier reply.", type: "text" }],
    "turn_0:assistant"
  );
  const nextUser = message(
    "user",
    [{ text: "And then?", type: "text" }],
    "turn_1:user"
  );
  assert.equal(
    shouldShowAssistantPending([user, prior, nextUser], "submitted"),
    true
  );
});
