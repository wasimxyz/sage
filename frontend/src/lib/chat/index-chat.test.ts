import assert from "node:assert/strict";
import test from "node:test";

import {
  indexChatMessages,
  indexChats,
  isDataDeleted,
  isOllamaUnavailable,
} from "./index-chat.ts";

const ollamaDown = /Local AI is not running/;

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
      Promise.reject(new Error("Local AI is not running."))
    ),
    ollamaDown
  );
});

test("isOllamaUnavailable knows the core's Ollama failures and nothing else", () => {
  for (const message of [
    "handler_failed: Local AI is not running.",
    "handler_failed: Local AI did not answer in time.",
    "handler_failed: The embedding model is not downloaded. Download nomic-embed-text in Settings › Models.",
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
  assert.equal(isOllamaUnavailable("Local AI is not running."), false);
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
      ? Promise.reject(new Error("handler_failed: Local AI is not running."))
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

test("isDataDeleted knows the delete message and nothing else", () => {
  assert.equal(
    isDataDeleted(new Error("handler_failed: Journal data was deleted.")),
    true
  );
  assert.equal(
    isDataDeleted(new Error("handler_failed: Local AI is not running.")),
    false
  );
  assert.equal(
    isDataDeleted(new Error("handler_failed: Chat not found.")),
    false
  );
  assert.equal(isDataDeleted("Journal data was deleted."), false);
  assert.equal(isDataDeleted(null), false);
});

test("indexChats tries a chat again when a delete cut its call off", async () => {
  const seen: number[] = [];
  const finished = await indexChats([1, 2], (id) => {
    seen.push(id);
    const cutOff = id === 1 && seen.filter((call) => call === 1).length === 1;
    return cutOff
      ? Promise.reject(new Error("handler_failed: Journal data was deleted."))
      : Promise.resolve({ more: false });
  });
  assert.equal(finished, true);
  assert.deepEqual(seen, [1, 1, 2]);
});

test("indexChats gives up on a chat after three cut-off calls and goes on", async () => {
  const seen: number[] = [];
  const finished = await indexChats([1, 2], (id) => {
    seen.push(id);
    return id === 1
      ? Promise.reject(new Error("handler_failed: Journal data was deleted."))
      : Promise.resolve({ more: false });
  });
  assert.equal(finished, true);
  assert.deepEqual(seen, [1, 1, 1, 2]);
});

test("indexChats does not try a chat again for its own failure", async () => {
  const seen: number[] = [];
  await indexChats([1], (id) => {
    seen.push(id);
    return Promise.reject(new Error("handler_failed: Chat not found."));
  });
  assert.deepEqual(seen, [1]);
});

test("indexChats says each chat is settled as soon as it is, whatever the result", async () => {
  const events: string[] = [];
  const finished = await indexChats(
    [1, 2, 3, 4],
    (id) => {
      events.push(`call ${id}`);
      if (id === 2) {
        return Promise.reject(new Error("handler_failed: Chat not found."));
      }
      if (id === 3) {
        return Promise.reject(
          new Error("handler_failed: Local AI is not running.")
        );
      }
      return Promise.resolve({ more: false });
    },
    (id) => events.push(`settled ${id}`)
  );
  assert.equal(finished, false);
  assert.deepEqual(events, [
    "call 1",
    "settled 1",
    "call 2",
    "settled 2",
    "call 3",
    "settled 3",
  ]);
});
