import assert from "node:assert/strict";
import test from "node:test";

import { conversationOf } from "eve/client";

import {
  historyMessages,
  messageIdAtSeq,
  splitChatLog,
  splitSessions,
} from "./chat-log.ts";
import { convertChatEvents } from "./legacy-events.ts";
import { legacyRecoveredChat } from "./test-chats.ts";

const chat = convertChatEvents(legacyRecoveredChat);
const secondStart = chat.findIndex(
  (event, index) => index > 0 && event.type === "session.started"
);

function seqOf(type: string, after = 0): number {
  return chat.findIndex(
    (event, index) => index >= after && event.type === type
  );
}

test("splitSessions starts a group at each session start", () => {
  const sessions = splitSessions(chat);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.length, secondStart);
});

test("splitChatLog resumes only the last session", () => {
  const resumed = splitChatLog(chat, true);
  assert.equal(resumed.history.length, secondStart);
  assert.equal(resumed.live[0]?.type, "session.started");
  assert.equal(resumed.history.length + resumed.live.length, chat.length);

  const ended = splitChatLog(chat, false);
  assert.equal(ended.history.length, chat.length);
  assert.equal(ended.live.length, 0);

  const single = splitChatLog(chat.slice(0, secondStart), true);
  assert.equal(single.history.length, 0);
});

test("historyMessages names each message's session", () => {
  const messages = historyMessages(chat);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"]
  );
  assert.equal(messages[0]?.id.startsWith("history-0:"), true);
  assert.equal(messages[2]?.id.startsWith("history-1:"), true);
  assert.notEqual(messages[1]?.id, messages[3]?.id);
});

test("messageIdAtSeq finds the message a history event shows in", () => {
  const messages = historyMessages(chat);
  const question = seqOf("delivery.consumed", secondStart);
  assert.equal(
    messageIdAtSeq(chat, false, question, messages),
    messages[2]?.id
  );
  const reply = chat.findIndex(
    (event, index) =>
      index > secondStart &&
      event.type === "content.completed" &&
      (event.data as { kind?: string }).kind === "text"
  );
  assert.equal(messageIdAtSeq(chat, false, reply, messages), messages[3]?.id);
});

test("messageIdAtSeq finds a live session's message without a prefix", () => {
  const { history, live } = splitChatLog(chat, true);
  const messages = [
    ...historyMessages(history),
    ...conversationOf(live).messages,
  ];
  const question = seqOf("delivery.consumed", secondStart);
  const id = messageIdAtSeq(chat, true, question, messages);
  assert.equal(id, conversationOf(live).messages[0]?.id);
  assert.equal(id?.startsWith("history-"), false);
});

test("messageIdAtSeq is null for an event that shows no message", () => {
  const messages = historyMessages(chat);
  assert.equal(messageIdAtSeq(chat, false, 0, messages), null);
  assert.equal(messageIdAtSeq(chat, false, chat.length, messages), null);
  assert.equal(messageIdAtSeq(chat, false, -1, messages), null);
});
