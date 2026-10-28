import assert from "node:assert/strict";
import test from "node:test";

import { indexChatMessages } from "./index-chat.ts";

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
