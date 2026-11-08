import assert from "node:assert/strict";
import test from "node:test";

import {
  chatReadOutput,
  chatSearchHits,
  readChatId,
} from "./chat-tool-output.ts";

test("chat ids are chat-12 and nothing else", () => {
  assert.equal(readChatId("chat-12"), 12);
  assert.equal(readChatId("entry-12"), null);
  assert.equal(readChatId(12), null);
  assert.equal(readChatId("chat-0"), null);
});

test("a search by meaning opens each chat at its best hit", () => {
  const output = {
    chats: [
      {
        active: "2026-10-19 to 2026-10-21",
        hits: [
          { date: "2026-10-20", from: "user", message: 4, text: "Hi" },
          { from: "sage", message: 1, text: "Hello" },
        ],
        id: "chat-2",
        title: "Sleep",
      },
      {
        active: "2026-09-01",
        hits: [{ from: "sage", message: 3, text: "Hello" }],
        id: "chat-1",
        title: "Lisbon",
      },
    ],
    note: "Showing 3 of 9 matching messages, at most 2 from each chat.",
  };
  assert.deepEqual(chatSearchHits(output), [
    { date: "2026-10-20", id: 2, seq: 4, title: "Sleep" },
    { date: "2026-09-01", id: 1, seq: 3, title: "Lisbon" },
  ]);
});

test("a search by time opens each chat at its end", () => {
  assert.deepEqual(
    chatSearchHits({
      chats: [
        { active: "2026-10-20", id: "chat-3", summary: "Move.", title: "Move" },
      ],
      range: { from: "2026-10-19", label: "last week", to: "2026-10-25" },
    }),
    [{ date: "2026-10-20", id: 3, seq: null, title: "Move" }]
  );
  assert.deepEqual(chatSearchHits({ chats: [] }), []);
});

test("a chat search result the card does not know is null", () => {
  assert.equal(chatSearchHits([]), null);
  assert.equal(chatSearchHits({ entries: [] }), null);
  assert.equal(chatSearchHits({ chats: [{ id: 3, title: "Old" }] }), null);
});

test("a chat read names the chat and the message it read around", () => {
  const output = {
    active: "2026-10-19 to 2026-10-21",
    id: "chat-2",
    messages: [
      { from: "user", message: 3, text: "Hi" },
      { date: "2026-10-21", from: "sage", message: 4, text: "Hello" },
    ],
    title: "Sleep",
  };
  assert.deepEqual(chatReadOutput({ id: "chat-2", message: 4 }, output), {
    date: "2026-10-21",
    id: 2,
    seq: 4,
    title: "Sleep",
  });
  assert.deepEqual(chatReadOutput({ id: "chat-2" }, output), {
    date: "2026-10-19",
    id: 2,
    seq: null,
    title: "Sleep",
  });
  assert.equal(chatReadOutput({}, { id: "entry-2", title: "Walk" }), null);
});
