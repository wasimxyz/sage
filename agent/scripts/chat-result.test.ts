import assert from "node:assert/strict";
import test from "node:test";

import {
  missingChatText,
  shapeChatList,
  shapeChatSearch,
  shapeChatWindow,
} from "../agent/lib/chat-result.ts";
import { instantsFromRange, localDayOf } from "../agent/lib/when.ts";

// Local days depend on the time zone, so these tests pin one with daylight
// saving time. Node reads TZ again when it changes.
process.env.TZ = "America/Los_Angeles";

const missingMessageStart = /^chat-12 has no message 39\./;
const missingMessageAdvice = /shown by search_chats or an earlier get_chat/;
const week = { from: "2026-10-19", label: "last week", to: "2026-10-25" };
const today = "2026-10-27";

test("instantsFromRange bounds local days, across a daylight saving change", () => {
  assert.deepEqual(instantsFromRange(week), {
    from: "2026-10-19T07:00:00.000Z",
    to: "2026-10-26T07:00:00.000Z",
  });
  // Daylight saving time ends on November 1, 2026 in Los Angeles.
  assert.deepEqual(
    instantsFromRange({ from: "2026-10-31", to: "2026-11-01" }),
    {
      from: "2026-10-31T07:00:00.000Z",
      to: "2026-11-02T08:00:00.000Z",
    }
  );
});

test("localDayOf turns a time into the local day", () => {
  assert.equal(localDayOf("2026-10-20T06:30:00.000Z"), "2026-10-19");
  assert.equal(localDayOf("2026-10-20T07:30:00.000Z"), "2026-10-20");
  assert.equal(localDayOf("nope"), null);
});

function hit(chat: number, message: number, overrides: object = {}) {
  return {
    chatCreatedAt: "2026-10-19T16:00:00.000Z",
    chatId: chat,
    chatUpdatedAt: "2026-10-21T16:00:00.000Z",
    message,
    role: message % 2 === 0 ? "user" : "assistant",
    savedAt: "2026-10-20T16:00:00.000Z",
    score: 0.7,
    snippet: `Message ${message}`,
    title: `Chat ${chat}`,
    ...overrides,
  };
}

test("shapeChatSearch groups hits by chat in order and names who spoke", () => {
  const result = shapeChatSearch({
    payload: {
      belowCutoff: 0,
      hits: [hit(2, 4), hit(1, 0), hit(2, 1, { savedAt: null })],
      matched: 3,
      unindexed: 0,
      unreadable: 0,
    },
    range: null,
    today,
  });
  assert.deepEqual(result, {
    chats: [
      {
        active: "2026-10-19 to 2026-10-21",
        hits: [
          { date: "2026-10-20", from: "user", message: 4, text: "Message 4" },
          { from: "sage", message: 1, text: "Message 1" },
        ],
        id: "chat-2",
        title: "Chat 2",
      },
      {
        active: "2026-10-19 to 2026-10-21",
        hits: [
          { date: "2026-10-20", from: "user", message: 0, text: "Message 0" },
        ],
        id: "chat-1",
        title: "Chat 1",
      },
    ],
  });
});

test("shapeChatSearch explains an empty or partial search", () => {
  const empty = shapeChatSearch({
    payload: {
      belowCutoff: 4,
      hits: [],
      matched: 0,
      unindexed: 2,
      unreadable: 1,
    },
    range: week,
    today,
  });
  assert.deepEqual(empty.chats, []);
  assert.deepEqual(empty.range, week);
  assert.equal(empty.today, today);
  assert.equal(
    empty.note,
    "4 messages from 2026-10-19 to 2026-10-25 didn't match closely enough to show. Leave out query to list the chats from then. 2 chats have messages this search can't see yet. Dream in the sidebar adds them. 1 message was indexed with another embedding model, so this search can't compare it."
  );

  const nothing = shapeChatSearch({
    payload: {
      belowCutoff: 0,
      hits: [],
      matched: 0,
      unindexed: 0,
      unreadable: 0,
    },
    range: null,
    today,
  });
  assert.equal(nothing.note, "No earlier chat matches.");
  assert.equal(nothing.range, undefined);

  const capped = shapeChatSearch({
    payload: { hits: [hit(1, 0), hit(1, 2)], matched: 7 },
    range: null,
    today,
  });
  assert.equal(
    capped.note,
    "Showing 2 of 7 matching messages, at most 2 from each chat."
  );
});

test("shapeChatList shows a summary or the first message", () => {
  const result = shapeChatList({
    payload: {
      chats: [
        {
          chatId: 3,
          firstAt: "2026-10-20T16:00:00.000Z",
          lastAt: "2026-10-20T18:00:00.000Z",
          snippet: "They talked about the move.",
          summarized: true,
          title: "Lisbon",
        },
        {
          chatId: 5,
          firstAt: "2026-10-21T16:00:00.000Z",
          lastAt: "2026-10-23T16:00:00.000Z",
          snippet: "I keep waking at 4am.",
          summarized: false,
          title: "Sleep",
        },
      ],
      total: 4,
    },
    range: week,
    today,
  });
  assert.deepEqual(result.chats, [
    {
      active: "2026-10-20",
      id: "chat-3",
      summary: "They talked about the move.",
      title: "Lisbon",
    },
    {
      active: "2026-10-21 to 2026-10-23",
      firstMessage: "I keep waking at 4am.",
      id: "chat-5",
      title: "Sleep",
    },
  ]);
  assert.equal(
    result.note,
    "Showing 2 of 4 chats, picked evenly in date order. Add a query or narrow when to see more. 1 chat has no summary yet, so it shows its first message. Dream in the sidebar adds summaries."
  );

  const none = shapeChatList({
    payload: { chats: [], total: 0 },
    range: week,
    today,
  });
  assert.equal(none.note, "No chats from 2026-10-19 to 2026-10-25.");
});

test("shapeChatWindow names the chat, its messages, and what is left out", () => {
  const result = shapeChatWindow({
    after: 1,
    before: 2,
    chatId: 4,
    createdAt: "2026-10-19T16:00:00.000Z",
    messages: [
      {
        cut: false,
        message: 5,
        role: "user",
        savedAt: "2026-10-20T16:00:00.000Z",
        text: "Hi",
      },
      {
        cut: true,
        message: 6,
        role: "assistant",
        savedAt: null,
        text: "A long reply",
      },
    ],
    summary: "They talked about sleep.",
    title: "Sleep",
    updatedAt: "2026-10-19T18:00:00.000Z",
  });
  assert.deepEqual(result, {
    active: "2026-10-19",
    id: "chat-4",
    messages: [
      { date: "2026-10-20", from: "user", message: 5, text: "Hi" },
      { cut: true, from: "sage", message: 6, text: "A long reply" },
    ],
    note: "2 earlier messages and 1 later message aren't shown. To read more, call get_chat with the first or last message number shown. Long messages are cut short.",
    summary: "They talked about sleep.",
    title: "Sleep",
  });

  const whole = shapeChatWindow({
    after: 0,
    before: 0,
    chatId: 4,
    messages: [],
    summary: null,
    title: "Sleep",
  });
  assert.equal(whole.note, undefined);
  assert.equal(whole.summary, undefined);
});

test("shapeChatWindow points at the edge message on the side that has more", () => {
  const window = (before: number, after: number) =>
    shapeChatWindow({
      after,
      before,
      chatId: 4,
      messages: [],
      summary: null,
      title: "Sleep",
    }).note;
  assert.equal(
    window(2, 0),
    "2 earlier messages aren't shown. To read more, call get_chat with the first message number shown."
  );
  assert.equal(
    window(0, 1),
    "1 later message isn't shown. To read more, call get_chat with the last message number shown."
  );
});

test("missingChatText tells a missing chat from a missing message", () => {
  assert.equal(
    missingChatText({ error: "not_found" }, 12, 39),
    "No chat has the id chat-12."
  );
  assert.equal(
    missingChatText({ error: "not_found" }, 12, undefined),
    "No chat has the id chat-12."
  );
  assert.equal(missingChatText(null, 12, 39), "No chat has the id chat-12.");
  const message = missingChatText({ error: "message_not_found" }, 12, 39);
  assert.match(message, missingMessageStart);
  assert.match(message, missingMessageAdvice);
});
