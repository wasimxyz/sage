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
const emptyAssistant = message("assistant", [], "turn_0:assistant");
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
      callId: "call_1",
      input: {},
      kind: "tool",
      label: "search_journal",
      name: "search_journal",
      state: "running",
      stepIndex: 0,
      type: "tool",
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
  assert.equal(
    assistantPartIsVisible({
      callId: "call_2",
      hidden: true,
      kind: "tool",
      label: "",
      name: "internal",
      state: "completed",
      stepIndex: 0,
      type: "tool",
    }),
    false
  );
});

test("shouldShowAssistantPending is true after send before the first token", () => {
  assert.equal(shouldShowAssistantPending([user], "busy"), true);
  assert.equal(
    shouldShowAssistantPending([user, emptyAssistant], "busy"),
    true
  );
  assert.equal(
    shouldShowAssistantPending([user, emptyReasoning], "busy"),
    true
  );
  assert.equal(shouldShowAssistantPending([user, emptyText], "busy"), true);
});

test("shouldShowAssistantPending hides once reasoning, text, or a tool appears", () => {
  assert.equal(shouldShowAssistantPending([user, reasoning], "busy"), false);
  assert.equal(shouldShowAssistantPending([user, reply], "busy"), false);
  assert.equal(shouldShowAssistantPending([user, tool], "busy"), false);
});

test("shouldShowAssistantPending stays off when the turn is idle or resuming", () => {
  assert.equal(shouldShowAssistantPending([user], "idle"), false);
  assert.equal(shouldShowAssistantPending([user], "resuming"), false);
  assert.equal(shouldShowAssistantPending([], "busy"), false);
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
    shouldShowAssistantPending([user, prior, nextUser], "busy"),
    true
  );
});
