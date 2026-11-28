import assert from "node:assert/strict";
import test from "node:test";

import { chatConvert, chatSave } from "../../bridge.ts";
import { installFakeChatCore } from "./fake-chat-core.ts";

const core = installFakeChatCore();
const writeFailed = /SqliteWriteFailed/u;
const keptFirst = /kept 0/u;

/** Events big enough that a save takes several chunks. */
function bigEvents(word: string): string {
  return JSON.stringify(
    Array.from({ length: 40 }, (_, index) => ({
      data: { text: `${word} ${String(index)} ${"x".repeat(2000)}` },
      type: "note",
    }))
  );
}

function newChatSave(events: string) {
  return chatSave({
    baseSeq: 0,
    contextLength: 8192,
    events,
    eveSessionId: null,
    id: null,
    model: "qwen3.5:9b",
    streamIndex: 0,
    thinking: false,
    title: "New chat",
  });
}

test("two saves never mix their chunks", async () => {
  core.chats.set(1, {
    eventFormat: 26,
    events: [{ type: "message.received" }],
  });
  const before = core.saves.length;
  const [id] = await Promise.all([
    newChatSave(bigEvents("reply")),
    chatConvert(1, bigEvents("converted")),
  ]);
  const calls = core.saves.slice(before);
  const first = calls.filter((save) => !save.convert);
  const second = calls.filter((save) => save.convert);
  assert.ok(first.length > 1, "the reply's save takes several chunks");
  assert.ok(second.length > 1, "the conversion takes several chunks");
  // Every chunk of the first save comes before any chunk of the second.
  const lastOfFirst = calls.lastIndexOf(first.at(-1) as (typeof calls)[number]);
  const firstOfSecond = calls.indexOf(second[0] as (typeof calls)[number]);
  assert.ok(lastOfFirst < firstOfSecond);
  assert.equal(core.chats.get(id)?.events.length, 40);
  assert.equal(core.chats.get(1)?.eventFormat, 27);
});

test("a save that fails partway does not hold up the next one", async () => {
  core.failNextSave(null, "SqliteWriteFailed", 1);
  const failed = newChatSave(bigEvents("lost"));
  const next = newChatSave(bigEvents("kept"));
  await assert.rejects(failed, writeFailed);
  const id = await next;
  const saved = core.chats.get(id)?.events ?? [];
  assert.equal(saved.length, 40);
  assert.match(JSON.stringify(saved[0]), keptFirst);
});
