import assert from "node:assert/strict";
import test from "node:test";

import { createChatIndexQueue } from "./chat-index-queue.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ready = Promise.resolve();

/** Lets queued promise callbacks run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the callbacks queued by the last one run
    await ready;
  }
}

/**
 * A stand-in for the core's chat index. A call holds the data generation it
 * started under, and fails with the core's message when a delete ran before
 * it ended, the way an embedding job does.
 */
function fakeCore(options: { hold?: Map<number, Deferred> } = {}) {
  const core = {
    calls: [] as number[],
    due(ids: number[]): number[] {
      return ids.filter((id) => !core.indexed.has(id));
    },
    async generate(id: number): Promise<{ more: boolean }> {
      core.calls.push(id);
      const started = core.generation;
      await (options.hold?.get(id)?.promise ?? ready);
      if (core.generation !== started) {
        throw new Error("handler_failed: Journal data was deleted.");
      }
      core.indexed.add(id);
      return { more: false };
    },
    generation: 0,
    indexed: new Set<number>(),
    wipe() {
      core.generation += 1;
      core.indexed.clear();
    },
  };
  return core;
}

test("a chat that is done can be queued again while the rest of its run goes on", async () => {
  const hold = new Map([[3, deferred()]]);
  const core = fakeCore({ hold });
  const queue = createChatIndexQueue({
    generate: core.generate,
    onOllamaDown: () => undefined,
  });
  queue.add([1, 2, 3, 4], ready);
  await settle();
  assert.deepEqual(core.calls, [1, 2, 3]);

  // 1 and 2 are done, 3 is running, 4 is waiting. Only 1 and 2 are free.
  const second = queue.add([1, 2, 3, 4, 5], ready);
  hold.get(3)?.resolve();
  await second;

  assert.deepEqual(core.calls, [1, 2, 3, 4, 1, 2, 5]);
});

test("a delete during a chat's call does not leave chats unindexed", async () => {
  // The reviewer's case. Chat 3's call is out when Delete embeddings runs.
  // The pass that follows lists every chat and finds 3 still running.
  const hold = new Map([[3, deferred()]]);
  const core = fakeCore({ hold });
  const queue = createChatIndexQueue({
    generate: core.generate,
    onOllamaDown: () => undefined,
  });
  const all = [1, 2, 3, 4, 5, 6];
  queue.add(core.due(all), ready);
  await settle();
  assert.deepEqual(core.calls, [1, 2, 3]);

  core.wipe();
  const second = queue.add(core.due(all), ready);
  hold.get(3)?.resolve();
  await second;

  assert.deepEqual(core.due(all), []);
  // 3 failed, then went again. 1 and 2 came from the second pass.
  assert.deepEqual(core.calls, [1, 2, 3, 3, 4, 5, 6, 1, 2]);
});

test("a delete between two chats leaves nothing to index twice", async () => {
  const core = fakeCore();
  const queue = createChatIndexQueue({
    generate: core.generate,
    onOllamaDown: () => undefined,
  });
  const all = [1, 2, 3];
  await queue.add(all, ready);
  core.wipe();
  await queue.add(core.due(all), ready);
  assert.deepEqual(core.due(all), []);
  assert.deepEqual(core.calls, [1, 2, 3, 1, 2, 3]);
});

test("a run that Ollama stops frees the chats it never reached", async () => {
  const ollama: { up: boolean } = { up: false };
  let stops = 0;
  const calls: number[] = [];
  const queue = createChatIndexQueue({
    generate: (id) => {
      calls.push(id);
      return ollama.up
        ? Promise.resolve({ more: false })
        : Promise.reject(new Error("handler_failed: Local AI is not running."));
    },
    onOllamaDown: () => {
      stops += 1;
    },
  });
  await queue.add([1, 2, 3], ready);
  assert.deepEqual(calls, [1]);
  assert.equal(stops, 1);

  ollama.up = true;
  await queue.add([1, 2, 3], ready);
  assert.deepEqual(calls, [1, 1, 2, 3]);
  assert.equal(stops, 1);
});

test("only Ollama stopping a run asks for the retry", async () => {
  let stops = 0;
  const queue = createChatIndexQueue({
    generate: (id) =>
      id === 2
        ? Promise.reject(new Error("handler_failed: Chat not found."))
        : Promise.resolve({ more: false }),
    onOllamaDown: () => {
      stops += 1;
    },
  });
  await queue.add([1, 2, 3], ready);
  assert.equal(stops, 0);
});

test("a chat waiting in a run is not queued twice", async () => {
  const core = fakeCore();
  const queue = createChatIndexQueue({
    generate: core.generate,
    onOllamaDown: () => undefined,
  });
  const gate = deferred();
  queue.add([1, 2, 2], gate.promise);
  queue.add([2, 3], gate.promise);
  gate.resolve();
  await queue.add([1], ready);
  assert.deepEqual(core.calls, [1, 2, 3]);
});

test("a run that ends does not free a chat a later pass has queued again", async () => {
  const hold = new Map([[2, deferred()]]);
  const core = fakeCore({ hold });
  const queue = createChatIndexQueue({
    generate: core.generate,
    onOllamaDown: () => undefined,
  });
  queue.add([1, 2], ready);
  await settle();
  // 1 is done and free, so the second pass takes it. It waits on the entries.
  const entries = deferred();
  queue.add([1], entries.promise);
  hold.get(2)?.resolve();
  await settle();
  // The first run has ended. The second still holds 1, so a third pass
  // leaves it alone.
  queue.add([1], ready);
  entries.resolve();
  await settle();
  assert.deepEqual(core.calls, [1, 2, 1]);
});
