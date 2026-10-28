import assert from "node:assert/strict";
import test from "node:test";

import {
  indexChatMessages,
  indexChats,
  isOllamaUnavailable,
} from "./index-chat.ts";

const ollamaDown = /Ollama is not running/;

test("indexChatMessages calls again while Sage asks for more", async () => {
  const answers = [true, true, false];
  const calls: number[] = [];
  await indexChatMessages(7, (id) => {
    calls.push(id);
    return Promise.resolve({ more: answers.shift() ?? false });
  });
  assert.deepEqual(calls, [7, 7, 7]);
});

test("indexChatMessages stops after a bounded number of calls", async () => {
  let calls = 0;
  await indexChatMessages(7, () => {
    calls += 1;
    return Promise.resolve({ more: true });
  });
  assert.equal(calls, 64);
});

test("indexChatMessages passes a failure on", async () => {
  await assert.rejects(
    indexChatMessages(7, () =>
      Promise.reject(new Error("Ollama is not running."))
    ),
    ollamaDown
  );
});

test("isOllamaUnavailable knows the core's Ollama failures and nothing else", () => {
  for (const message of [
    "handler_failed: Ollama is not running.",
    "handler_failed: Ollama did not answer in time.",
    "handler_failed: The embedding model is not pulled. Run: ollama pull nomic-embed-text",
    "handler_failed: Embedding failed.",
  ]) {
    assert.equal(isOllamaUnavailable(new Error(message)), true, message);
  }
  for (const message of [
    "handler_failed: Chat not found.",
    "handler_failed: Journal data was deleted.",
    "handler_failed: Could not store the embeddings.",
    "handler_failed: Sage is locked.",
  ]) {
    assert.equal(isOllamaUnavailable(new Error(message)), false, message);
  }
  assert.equal(isOllamaUnavailable("Ollama is not running."), false);
  assert.equal(isOllamaUnavailable(null), false);
});

test("indexChats skips a chat that fails for its own reasons and goes on", async () => {
  const seen: number[] = [];
  const finished = await indexChats([1, 2, 3], (id) => {
    seen.push(id);
    return id === 2
      ? Promise.reject(new Error("handler_failed: Chat not found."))
      : Promise.resolve({ more: false });
  });
  assert.equal(finished, true);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("indexChats stops and says so when Ollama is down", async () => {
  const seen: number[] = [];
  const finished = await indexChats([1, 2, 3], (id) => {
    seen.push(id);
    return id === 2
      ? Promise.reject(new Error("handler_failed: Ollama is not running."))
      : Promise.resolve({ more: false });
  });
  assert.equal(finished, false);
  assert.deepEqual(seen, [1, 2]);
});

test("indexChats finishes a chat's batches before the next chat", async () => {
  const calls: number[] = [];
  const rounds: Record<number, number> = { 1: 2, 2: 1 };
  await indexChats([1, 2], (id) => {
    calls.push(id);
    rounds[id] -= 1;
    return Promise.resolve({ more: rounds[id] > 0 });
  });
  assert.deepEqual(calls, [1, 1, 2]);
});
