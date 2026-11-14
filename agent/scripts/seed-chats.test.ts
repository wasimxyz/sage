// The bridge calls that seed a person's past chats, answered by a fake Sage.

import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedChat } from "../evals/lib/dataset.ts";
import { chatMessageOf } from "../evals/lib/dream-accuracy.ts";
import {
  type BridgeCall,
  CHAT_CHUNK_BYTES,
  chatEvents,
  chatEventsJson,
  indexChat,
  pendingChatIds,
  saveChat,
  seedChats,
} from "./seed-chats.ts";

const pattern4 =
  /Save did not return an id for sam past chat 1 \(2026-09-12-chat-1\)/u;
const pattern3 = /Chat 3 still had messages to embed after 64 rounds/u;
const pattern2 = /Sage is locked/u;
const pattern1 =
  /Past chat 11 of sam still needs indexing after embeddings\.generate\. Is the embedding model pulled\?/u;

function chatOf(
  index: number,
  turns: LoadedChat["turns"],
  title = `Chat ${index}`
): LoadedChat {
  return {
    date: "2026-09-12",
    fileName: `2026-09-12-chat-${index}.md`,
    index,
    stem: `2026-09-12-chat-${index}`,
    title,
    turns,
    wordCount: 1,
  };
}

const SHORT = chatOf(1, [
  { role: "user", text: "I went to the group on Thursday." },
  { role: "assistant", text: "How did it go?" },
  { role: "user", text: "Fine. A cookie, too." },
  { role: "assistant", text: "A cookie helps." },
]);

interface Call {
  command: string;
  id: string;
  payload: Record<string, unknown>;
}

/**
 * A fake Sage. It keeps the chunks of a save, makes ids from 10, embeds
 * `batch` messages per `embeddings.generate`, and lists the chats still
 * waiting. `stuck` names chats that never finish.
 */
function fakeSage(
  options: { batch?: number; ok?: boolean; stuck?: number[] } = {}
) {
  const calls: Call[] = [];
  const saved = new Map<number, { events: string; title: string }>();
  const left = new Map<number, number>();
  let nextId = 10;
  let building: { events: string; title: string } | null = null;
  const call: BridgeCall = (command, payload, id) => {
    calls.push({ command, id, payload });
    if (options.ok === false) {
      return { error: { message: "Sage is locked." }, id, ok: false };
    }
    if (command === "chat.save") {
      if (payload.offset === 0) {
        building = { events: "", title: String(payload.title) };
      }
      assert.ok(building);
      assert.equal(
        Buffer.byteLength(building.events, "utf8"),
        payload.offset,
        "offsets run on from the bytes already sent"
      );
      building.events += String(payload.chunk);
      if (payload.done !== true) {
        return { id, ok: true, result: { done: false, id: null } };
      }
      const chatId = nextId;
      nextId += 1;
      saved.set(chatId, building);
      const events = JSON.parse(building.events) as unknown[];
      left.set(chatId, events.length);
      return { id, ok: true, result: { id: chatId } };
    }
    if (command === "embeddings.generate") {
      const chatId = Number(payload.chatId);
      const remaining = left.get(chatId) ?? 0;
      const take = Math.min(remaining, options.batch ?? 32);
      // A stuck chat says it is done and stays on the pending list.
      const stuck = options.stuck?.includes(chatId) === true;
      if (!stuck) {
        left.set(chatId, remaining - take);
      }
      return {
        id,
        ok: true,
        result: { more: !stuck && (left.get(chatId) ?? 0) > 0 && take > 0 },
      };
    }
    if (command === "embeddings.pending") {
      const chatIds = [...left.entries()].flatMap(([chatId, remaining]) =>
        remaining > 0 ? [chatId] : []
      );
      return { id, ok: true, result: { chatIds, ids: [] } };
    }
    return { id, ok: true, result: {} };
  };
  return { call, calls, saved };
}

test("a chat's events are what the Chat screen saves: a received message and a completed reply", () => {
  const events = chatEvents(SHORT).map((text) => JSON.parse(text));
  assert.deepEqual(events[0], {
    data: {
      message: "I went to the group on Thursday.",
      parts: [{ text: "I went to the group on Thursday.", type: "text" }],
      turnId: "turn_0",
    },
    type: "message.received",
  });
  assert.deepEqual(events[1], {
    data: { finishReason: "stop", message: "How did it go?" },
    type: "message.completed",
  });
  assert.equal(events[2].data.turnId, "turn_1");
  assert.equal(events.length, 4);
});

test("Dream accuracy and Sage's index read these events as the same messages", () => {
  const read = chatEvents(SHORT).map((text) => chatMessageOf(text));
  assert.deepEqual(read, [
    { role: "user", text: "I went to the group on Thursday." },
    { role: "assistant", text: "How did it go?" },
    { role: "user", text: "Fine. A cookie, too." },
    { role: "assistant", text: "A cookie helps." },
  ]);
  assert.deepEqual(JSON.parse(chatEventsJson(SHORT)).length, 4);
});

test("saveChat sends the title, no id, and the events in one chunk, and returns Sage's id", () => {
  const sage = fakeSage();
  const id = saveChat(sage.call, "sam", SHORT);
  assert.equal(id, 10);
  assert.equal(sage.calls.length, 1);
  const [only] = sage.calls;
  assert.equal(only?.command, "chat.save");
  assert.equal(only?.id, "chat-save-sam-1-0");
  assert.deepEqual(
    { ...only?.payload, chunk: undefined },
    {
      baseSeq: 0,
      chunk: undefined,
      contextLength: 32_768,
      done: true,
      eveSessionId: null,
      id: null,
      model: null,
      offset: 0,
      streamIndex: 0,
      thinking: null,
      title: "Chat 1",
    }
  );
  assert.equal(sage.saved.get(10)?.events, chatEventsJson(SHORT));
  assert.equal(sage.saved.get(10)?.title, "Chat 1");
});

test("a long chat goes in chunks, each with its byte offset, the same id after the first, and done only on the last", () => {
  const long = chatOf(
    2,
    Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Message ${index}: ${"é😀 and some more words. ".repeat(20)}`,
    }))
  );
  const sage = fakeSage();
  const id = saveChat(sage.call, "sam", long);
  assert.equal(id, 10);
  assert.ok(sage.calls.length > 2, `${sage.calls.length} chunks`);
  sage.calls.forEach((entry, index) => {
    assert.equal(entry.payload.done, index === sage.calls.length - 1);
    assert.equal(
      entry.payload.id,
      null,
      "the id is null until the last answer"
    );
    assert.ok(
      Buffer.byteLength(String(entry.payload.chunk), "utf8") <= CHAT_CHUNK_BYTES
    );
    assert.equal(entry.id, `chat-save-sam-2-${index}`);
  });
  // The pieces put back together are the whole array, with no character split.
  assert.equal(sage.saved.get(10)?.events, chatEventsJson(long));
  assert.equal(JSON.parse(sage.saved.get(10)?.events ?? "[]").length, 40);
});

test("a failed save is an error, and a save that returns no id is an error", () => {
  assert.throws(
    () => saveChat(fakeSage({ ok: false }).call, "sam", SHORT),
    pattern2
  );
  const silent: BridgeCall = (_command, _payload, id) => ({
    id,
    ok: true,
    result: { done: true },
  });
  assert.throws(() => saveChat(silent, "sam", SHORT), pattern4);
});

test("indexChat calls embeddings.generate with the chat id until Sage says no more", () => {
  const sage = fakeSage({ batch: 1 });
  const id = saveChat(sage.call, "sam", SHORT);
  sage.calls.length = 0;
  indexChat(sage.call, "sam", id);
  assert.deepEqual(
    sage.calls.map((entry) => entry.command),
    new Array(4).fill("embeddings.generate")
  );
  assert.deepEqual(
    sage.calls.map((entry) => entry.payload),
    new Array(4).fill({ chatId: id })
  );
  assert.equal(new Set(sage.calls.map((entry) => entry.id)).size, 4);
});

test("indexChat gives up when Sage keeps saying there is more", () => {
  const forever: BridgeCall = (_command, _payload, id) => ({
    id,
    ok: true,
    result: { more: true },
  });
  assert.throws(() => indexChat(forever, "sam", 3), pattern3);
});

test("a failed embedding call is an error", () => {
  assert.throws(
    () => indexChat(fakeSage({ ok: false }).call, "sam", 3),
    pattern2
  );
});

test("pendingChatIds lists the chats Sage still has to index", () => {
  const call: BridgeCall = (_command, _payload, id) => ({
    id,
    ok: true,
    result: JSON.stringify({ chatIds: [3, "x", 5], ids: [1] }),
  });
  assert.deepEqual(pendingChatIds(call, "p"), [3, 5]);
  const none: BridgeCall = (_command, _payload, id) => ({
    id,
    ok: true,
    result: {},
  });
  assert.deepEqual(pendingChatIds(none, "p"), []);
});

test("seedChats saves every chat, then indexes each, then checks that none is waiting, and returns the ids in order", () => {
  const sage = fakeSage({ batch: 2 });
  const second = chatOf(2, [
    { role: "user", text: "Hi." },
    { role: "assistant", text: "Hello." },
  ]);
  const ids = seedChats(sage.call, "sam", [SHORT, second]);
  assert.deepEqual(ids, [10, 11]);
  const commands = sage.calls.map((entry) => entry.command);
  assert.deepEqual(commands.slice(0, 2), ["chat.save", "chat.save"]);
  assert.equal(commands.at(-1), "embeddings.pending");
  const generated = sage.calls
    .filter((entry) => entry.command === "embeddings.generate")
    .map((entry) => entry.payload.chatId);
  assert.deepEqual(generated, [10, 10, 11]);
  assert.equal(
    new Set(sage.calls.map((entry) => entry.id)).size,
    sage.calls.length,
    "no request id is used twice"
  );
});

test("seedChats names a chat that is still waiting for its index after the calls", () => {
  const sage = fakeSage({ stuck: [11] });
  const second = chatOf(2, [
    { role: "user", text: "Hi." },
    { role: "assistant", text: "Hello." },
  ]);
  assert.throws(() => seedChats(sage.call, "sam", [SHORT, second]), pattern1);
});

test("a person with no chats makes no calls", () => {
  const sage = fakeSage();
  assert.deepEqual(seedChats(sage.call, "sam", []), []);
  assert.deepEqual(
    sage.calls.map((entry) => entry.command),
    ["embeddings.pending"]
  );
});
