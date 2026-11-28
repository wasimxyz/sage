import assert from "node:assert/strict";
import test from "node:test";

import { conversationOf, type SessionStreamEvent } from "eve/client";

import { splitSessions } from "./chat-log.ts";
import {
  convertChatEvents,
  isConvertedEvent,
  isConvertedLog,
} from "./legacy-events.ts";
import { legacyRecoveredChat, legacySession } from "./test-chats.ts";

function said(events: readonly SessionStreamEvent[]): string[][] {
  return conversationOf(events).messages.map((message) => [
    message.role,
    ...message.parts.map((part) => {
      if (part.type === "tool") {
        return `tool:${part.name}:${part.state}`;
      }
      return part.type === "text" ? part.text : part.type;
    }),
  ]);
}

test("a saved eve 0.80 session converts with its messages and tool call", () => {
  const converted = convertChatEvents(legacySession);
  assert.equal(isConvertedLog(converted), true);
  assert.deepEqual(said(converted), [
    ["user", "How did I sleep last week?"],
    [
      "assistant",
      "Let me look.",
      "tool:search_journal:completed",
      "Nothing from last week.",
    ],
  ]);
});

test("each session of a recovered chat converts on its own", () => {
  const converted = convertChatEvents(legacyRecoveredChat);
  const sessions = splitSessions(converted);
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session[0]?.type, "session.started");
    assert.deepEqual(session[0]?.meta.position, { index: 0, line: 0 });
  }
  assert.deepEqual(said(sessions[1] ?? []), [
    ["user", "And the week before?"],
    ["assistant", "You slept well."],
  ]);
});

test("converted events stay as they are", () => {
  const converted = convertChatEvents(legacyRecoveredChat);
  assert.deepEqual(convertChatEvents(converted), converted);
  assert.equal(isConvertedEvent(legacySession[0]), false);
  assert.equal(isConvertedEvent(converted[0]), true);
});

test("a chat with no session start or steps keeps what was said", () => {
  // Early eve releases wrote bare messages. eve's converter would drop the
  // reply, so the chat converts from its messages alone.
  const converted = convertChatEvents([
    { data: { message: "Hello" }, type: "message.received" },
    { data: { message: "Hi there." }, type: "message.completed" },
    { data: { message: "One more" }, type: "message.received" },
  ]);
  assert.deepEqual(said(converted), [
    ["user", "Hello"],
    ["assistant", "Hi there."],
    ["user", "One more"],
  ]);
});

test("a session eve cannot read converts from its messages", () => {
  const converted = convertChatEvents([
    legacySession[0],
    "not an event",
    { data: { message: "Hello", turnId: "turn_0" }, type: "message.received" },
    {
      data: { message: "Hi there.", turnId: "turn_0" },
      type: "message.completed",
    },
  ]);
  assert.deepEqual(said(converted), [
    ["user", "Hello"],
    ["assistant", "Hi there."],
  ]);
});
