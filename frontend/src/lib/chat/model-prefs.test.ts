import assert from "node:assert/strict";
import test from "node:test";

import { convertChatEvents } from "./legacy-events.ts";
import { lastModelIdFromEvents, prefsFromConversation } from "./model-prefs.ts";

const fallback = {
  contextLength: 32_768,
  model: "qwen3.5:9b",
  thinking: false,
};

function modelStarted(modelId: string): Record<string, unknown> {
  return {
    data: { attempt: 0, modelId, runId: "run_0" },
    type: "model.started",
  };
}

test("lastModelIdFromEvents reads the last model a run named", () => {
  assert.equal(
    lastModelIdFromEvents([
      modelStarted("ollama/llama3.2:3b"),
      modelStarted("ollama/qwen3.5:9b"),
    ]),
    "qwen3.5:9b"
  );
  assert.equal(lastModelIdFromEvents([]), null);
});

test("lastModelIdFromEvents skips a run eve could not name", () => {
  // eve's converter names the model "unknown" for an old step with none.
  assert.equal(
    lastModelIdFromEvents([
      modelStarted("ollama/llama3.2:3b"),
      modelStarted("unknown"),
    ]),
    "llama3.2:3b"
  );
  assert.equal(lastModelIdFromEvents([modelStarted("unknown")]), null);
});

test("an old chat with no saved model opens on the model its steps named", () => {
  // A row from before the model column, whose last reply had no step.
  const events = convertChatEvents([
    { data: {}, type: "session.started" },
    { data: { turnId: "turn_0" }, type: "turn.started" },
    { data: { message: "Hi", turnId: "turn_0" }, type: "message.received" },
    {
      data: { modelId: "ollama/llama3.2:3b", stepIndex: 0, turnId: "turn_0" },
      type: "step.started",
    },
    {
      data: { message: "Hello.", stepIndex: 0, turnId: "turn_0" },
      type: "message.completed",
    },
    { data: { stepIndex: 0, turnId: "turn_0" }, type: "step.completed" },
    { data: { message: "And?", turnId: "turn_0" }, type: "message.received" },
    {
      data: { message: "That's all.", stepIndex: 1, turnId: "turn_0" },
      type: "message.completed",
    },
    { data: { turnId: "turn_0" }, type: "turn.completed" },
  ]);
  const prefs = prefsFromConversation(
    { contextLength: null, events, model: "", thinking: null },
    fallback
  );
  assert.equal(prefs.model, "llama3.2:3b");

  const bare = convertChatEvents([
    { data: { message: "Hello" }, type: "message.received" },
    { data: { message: "Hi there." }, type: "message.completed" },
  ]);
  assert.equal(
    prefsFromConversation(
      { contextLength: null, events: bare, model: "", thinking: null },
      fallback
    ).model,
    "qwen3.5:9b"
  );
});
