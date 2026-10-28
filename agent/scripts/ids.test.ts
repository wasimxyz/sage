import assert from "node:assert/strict";
import test from "node:test";

import {
  chatId,
  currentChatId,
  entryId,
  labelEntryIds,
  readId,
  sourceLabel,
} from "../agent/lib/ids.ts";

test("entry and chat ids carry their kind", () => {
  assert.equal(entryId(12), "entry-12");
  assert.equal(chatId(12), "chat-12");
});

test("readId reads prefixed ids and treats a plain number as an entry", () => {
  assert.deepEqual(readId("entry-12"), { id: 12, kind: "entry" });
  assert.deepEqual(readId("chat-12"), { id: 12, kind: "chat" });
  assert.deepEqual(readId(" Chat-7 "), { id: 7, kind: "chat" });
  assert.deepEqual(readId(12), { id: 12, kind: "entry" });
  assert.deepEqual(readId("12"), { id: 12, kind: "entry" });
});

test("readId refuses anything that is not an id", () => {
  for (const value of [
    0,
    -1,
    1.5,
    "0",
    "chat-0",
    "chat-",
    "chat-12x",
    "memo-3",
    "",
    null,
    undefined,
    { id: 3 },
  ]) {
    assert.equal(readId(value), null, String(value));
  }
});

test("sourceLabel names an entry, a chat, or the user", () => {
  assert.equal(sourceLabel("entry", 3), "entry-3");
  assert.equal(sourceLabel("conversation", 4), "chat-4");
  assert.equal(sourceLabel("user", 0), "you");
});

test("labelEntryIds prefixes entry ids wherever the journal routes put them", () => {
  const entry = { date: "2026-03-14", id: 3, title: "Walk" };
  assert.deepEqual(labelEntryIds([entry]), [{ ...entry, id: "entry-3" }]);
  assert.deepEqual(labelEntryIds({ entries: [entry], total: 1 }), {
    entries: [{ ...entry, id: "entry-3" }],
    total: 1,
  });
  assert.deepEqual(labelEntryIds({ body: "Fog.", id: 3 }), {
    body: "Fog.",
    id: "entry-3",
  });
  assert.deepEqual(labelEntryIds({ entries: [{ id: "entry-3" }] }), {
    entries: [{ id: "entry-3" }],
  });
  assert.equal(labelEntryIds(null), null);
});

test("currentChatId reads the saved chat id attribute", () => {
  const ctx = (attributes?: Record<string, unknown>) => ({
    session: {
      auth: { current: attributes === undefined ? null : { attributes } },
    },
  });
  assert.equal(currentChatId(ctx({ chatId: "9" })), 9);
  assert.equal(currentChatId(ctx({ chatId: "0" })), null);
  assert.equal(currentChatId(ctx({ chatId: "chat-9" })), null);
  assert.equal(currentChatId(ctx({})), null);
  assert.equal(currentChatId(ctx()), null);
});
