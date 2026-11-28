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

const at = (second: number) =>
  `2026-03-01T10:00:${String(second).padStart(2, "0")}.000Z`;

test("a reply eve leaves out is kept when your message is only in its parts", () => {
  // eve counts the message that has text only in its parts. A plain count
  // of messages would then hide the reply it left out.
  const converted = convertChatEvents([
    { data: { runtime: {} }, meta: { at: at(0) }, type: "session.started" },
    {
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: at(1) },
      type: "turn.started",
    },
    {
      data: {
        message: "",
        parts: [{ text: "Only in parts", type: "text" }],
        turnId: "turn_0",
      },
      meta: { at: at(1) },
      type: "message.received",
    },
    { data: { turnId: "turn_0" }, meta: { at: at(2) }, type: "turn.completed" },
    {
      data: { message: "Late reply", stepIndex: 0, turnId: "turn_0" },
      meta: { at: at(3) },
      type: "message.completed",
    },
  ]);
  assert.deepEqual(said(converted), [
    ["user", "Only in parts"],
    ["assistant", "Late reply"],
  ]);
});

test("a session converted from its messages keeps the model it used", () => {
  // The reply comes after the turn ended, so eve's converter drops it and
  // Chat converts from the messages.
  const converted = convertChatEvents([
    { data: {}, meta: { at: at(0) }, type: "session.started" },
    { data: { turnId: "turn_0" }, meta: { at: at(1) }, type: "turn.started" },
    {
      data: { message: "Hi", turnId: "turn_0" },
      meta: { at: at(1) },
      type: "message.received",
    },
    {
      data: { modelId: "ollama/llama3.2:3b", stepIndex: 0, turnId: "turn_0" },
      meta: { at: at(2) },
      type: "step.started",
    },
    { data: { turnId: "turn_0" }, meta: { at: at(3) }, type: "turn.completed" },
    {
      data: { message: "Hello.", stepIndex: 0, turnId: "turn_0" },
      meta: { at: at(3) },
      type: "message.completed",
    },
  ]);
  assert.deepEqual(said(converted), [
    ["user", "Hi"],
    ["assistant", "Hello."],
  ]);
  const models = converted.flatMap((event) =>
    event.type === "model.started"
      ? [(event.data as { modelId: string }).modelId]
      : []
  );
  assert.deepEqual(models, ["ollama/llama3.2:3b"]);
});
