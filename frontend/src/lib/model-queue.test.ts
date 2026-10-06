import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaPullProgress } from "@/bridge";
import {
  enqueueModels,
  modelRowState,
  nextQueueStep,
  pullMatches,
} from "./model-queue.ts";

const embed = "nomic-embed-text";
const summary = "qwen3.5:9b";

function pull(overrides: Partial<OllamaPullProgress>): OllamaPullProgress {
  return {
    active: false,
    cancelled: false,
    completed: 0,
    done: false,
    failed: false,
    model: embed,
    status: "",
    total: 0,
    ...overrides,
  };
}

test("an empty queue with no download is idle", () => {
  assert.deepEqual(nextQueueStep({ pull: null, queue: [], started: null }), {
    kind: "idle",
  });
});

test("an empty queue waits while some other download runs", () => {
  assert.deepEqual(
    nextQueueStep({ pull: pull({ active: true }), queue: [], started: null }),
    { kind: "wait" }
  );
});

test("the head starts when nothing is downloading", () => {
  assert.deepEqual(
    nextQueueStep({ pull: null, queue: [embed, summary], started: null }),
    { kind: "start", model: embed }
  );
});

test("the head is watched while it downloads", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ active: true }),
      queue: [embed, summary],
      started: null,
    }),
    { kind: "watch", model: embed }
  );
});

test("the head waits while another model downloads", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ active: true, model: "llama3.2:3b" }),
      queue: [embed],
      started: null,
    }),
    { kind: "wait" }
  );
});

test("a finished head comes off the queue", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ done: true }),
      queue: [embed, summary],
      started: embed,
    }),
    { kind: "finish", model: embed, outcome: "done" }
  );
});

test("a cancelled or failed head comes off the queue too", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ cancelled: true }),
      queue: [embed],
      started: embed,
    }),
    { kind: "finish", model: embed, outcome: "cancelled" }
  );
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ failed: true }),
      queue: [embed],
      started: embed,
    }),
    { kind: "finish", model: embed, outcome: "failed" }
  );
});

test("a finished pull the page did not start is not the queue's own", () => {
  // After a refresh the core still holds the last pull. Without a start from
  // this page, a stale "done" must not finish a model that was never fetched.
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ done: true }),
      queue: [embed],
      started: null,
    }),
    { kind: "start", model: embed }
  );
});

test("a finished pull for another model starts the head", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ done: true, model: summary }),
      queue: [embed],
      started: embed,
    }),
    { kind: "start", model: embed }
  );
});

test("the next model starts once the first comes off", () => {
  assert.deepEqual(
    nextQueueStep({
      pull: pull({ done: true }),
      queue: [summary],
      started: null,
    }),
    { kind: "start", model: summary }
  );
});

test("a pull matches its model by the name the lists use", () => {
  assert.equal(pullMatches({ model: "qwen3.5:9b" }, summary), true);
  assert.equal(pullMatches({ model: "nomic-embed-text:latest" }, embed), true);
  assert.equal(pullMatches({ model: "llama3.2:3b" }, summary), false);
});

test("enqueue keeps order and skips models already waiting", () => {
  assert.deepEqual(enqueueModels([embed], [embed, summary]), [embed, summary]);
  assert.deepEqual(enqueueModels([], [summary, embed, summary]), [
    summary,
    embed,
  ]);
});

// --- the rows ---

const idle = {
  problems: {},
  pull: null,
  queue: [],
  ready: false,
  running: true,
};

test("a pulled model is ready, whatever else is going on", () => {
  assert.deepEqual(
    modelRowState({
      ...idle,
      model: embed,
      pull: pull({ active: true }),
      ready: true,
    }),
    { kind: "ready" }
  );
});

test("the active download shows its percent", () => {
  assert.deepEqual(
    modelRowState({
      ...idle,
      model: summary,
      pull: pull({ active: true, completed: 420, model: summary, total: 1000 }),
      queue: [summary],
    }),
    { kind: "downloading", percent: 42 }
  );
});

test("a download with no size yet shows no percent", () => {
  assert.deepEqual(
    modelRowState({
      ...idle,
      model: embed,
      pull: pull({ active: true, total: 0 }),
      queue: [embed],
    }),
    { kind: "downloading", percent: null }
  );
});

test("a model that failed shows why, with a way to try again", () => {
  assert.deepEqual(
    modelRowState({
      ...idle,
      model: summary,
      problems: { [summary]: "Download failed." },
    }),
    { kind: "problem", message: "Download failed." }
  );
});

test("a queued model waits for its turn", () => {
  assert.deepEqual(
    modelRowState({
      ...idle,
      model: summary,
      pull: pull({ active: true }),
      queue: [embed, summary],
    }),
    { kind: "waiting" }
  );
});

test("a model reads as checking until Sage has looked", () => {
  assert.deepEqual(modelRowState({ ...idle, model: embed, ready: null }), {
    kind: "checking",
  });
});

test("with Ollama down and nothing queued there is nothing to show", () => {
  assert.deepEqual(modelRowState({ ...idle, model: embed, running: false }), {
    kind: "unavailable",
  });
  assert.deepEqual(modelRowState({ ...idle, model: embed }), {
    kind: "waiting",
  });
});
