import assert from "node:assert/strict";
import test from "node:test";

import { conversationOf, type SessionStreamEvent } from "eve/client";

import { historyMessages, splitSessions } from "./chat-log.ts";
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

test("a turn the app quit during keeps your message, with no empty reply", () => {
  const converted = convertChatEvents([
    { data: { runtime: {} }, meta: { at: at(0) }, type: "session.started" },
    {
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: at(1) },
      type: "turn.started",
    },
    {
      data: {
        message: "Hello?",
        parts: [{ text: "Hello?", type: "text" }],
        turnId: "turn_0",
      },
      meta: { at: at(1) },
      type: "message.received",
    },
    {
      data: { modelId: "qwen3.5:9b", stepIndex: 0, turnId: "turn_0" },
      meta: { at: at(2) },
      type: "step.started",
    },
  ]);
  assert.deepEqual(said(converted), [["user", "Hello?"]]);
  // The turn ends as stopped, so nothing shows it as still running.
  assert.equal(converted.at(-1)?.type, "delivery.settled");
  assert.ok(converted.some((event) => event.type === "turn.settled"));
});

test("a tool call that failed converts as failed, with its error", () => {
  const turn = { sequence: 0, turnId: "turn_0" };
  const converted = convertChatEvents([
    { data: { runtime: {} }, meta: { at: at(0) }, type: "session.started" },
    { data: turn, meta: { at: at(1) }, type: "turn.started" },
    {
      data: {
        ...turn,
        message: "Find it",
        parts: [{ text: "Find it", type: "text" }],
      },
      meta: { at: at(1) },
      type: "message.received",
    },
    {
      data: { ...turn, modelId: "qwen3.5:9b", stepIndex: 0 },
      meta: { at: at(2) },
      type: "step.started",
    },
    {
      data: {
        ...turn,
        actions: [
          {
            callId: "c1",
            input: { query: "x" },
            kind: "tool-call",
            toolName: "search_journal",
          },
        ],
        stepIndex: 0,
      },
      meta: { at: at(2) },
      type: "actions.requested",
    },
    {
      data: {
        ...turn,
        error: { code: "tool_error", message: "Local AI is not running." },
        result: {
          callId: "c1",
          kind: "tool-result",
          toolName: "search_journal",
        },
        status: "failed",
      },
      meta: { at: at(3) },
      type: "action.result",
    },
    {
      data: { ...turn, finishReason: "tool-calls", stepIndex: 0 },
      meta: { at: at(3) },
      type: "step.completed",
    },
    {
      data: { ...turn, modelId: "qwen3.5:9b", stepIndex: 1 },
      meta: { at: at(4) },
      type: "step.started",
    },
    {
      data: {
        ...turn,
        finishReason: "stop",
        message: "I couldn't search.",
        stepIndex: 1,
      },
      meta: { at: at(4) },
      type: "message.completed",
    },
    {
      data: { ...turn, finishReason: "stop", stepIndex: 1 },
      meta: { at: at(4) },
      type: "step.completed",
    },
    { data: turn, meta: { at: at(5) }, type: "turn.completed" },
  ]);
  assert.deepEqual(said(converted), [
    ["user", "Find it"],
    ["assistant", "tool:search_journal:failed", "I couldn't search."],
  ]);
  const tool = conversationOf(converted).messages[1]?.parts.find(
    (part) => part.type === "tool"
  );
  assert.equal(
    tool?.type === "tool" ? tool.error?.message : undefined,
    "Local AI is not running."
  );
});

test("a first message saved before its session.started still shows", () => {
  // Recovery in eve 0.80 could save the new session's first message ahead
  // of the session's start.
  const turn = { sequence: 0, turnId: "turn_0" };
  const converted = convertChatEvents([
    ...legacySession,
    {
      data: {
        ...turn,
        message: "And the week before?",
        parts: [{ text: "And the week before?", type: "text" }],
      },
      meta: { at: at(1) },
      type: "message.received",
    },
    { data: { runtime: {} }, meta: { at: at(2) }, type: "session.started" },
    { data: turn, meta: { at: at(2) }, type: "turn.started" },
    {
      data: { ...turn, modelId: "qwen3.5:9b", stepIndex: 0 },
      meta: { at: at(3) },
      type: "step.started",
    },
    {
      data: {
        ...turn,
        finishReason: "stop",
        message: "You slept well.",
        stepIndex: 0,
      },
      meta: { at: at(3) },
      type: "message.completed",
    },
    {
      data: { ...turn, finishReason: "stop", stepIndex: 0 },
      meta: { at: at(3) },
      type: "step.completed",
    },
    { data: turn, meta: { at: at(4) }, type: "turn.completed" },
  ]);
  // Chat draws each session on its own, as the chat screen does.
  const texts = historyMessages(converted).map((message) =>
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
  );
  assert.ok(texts.includes("And the week before?"));
  assert.ok(texts.includes("You slept well."));
});

test("an event with no time takes the time of the one before it", () => {
  const converted = convertChatEvents([
    { data: {}, meta: { at: at(5) }, type: "session.started" },
    { data: { turnId: "turn_0" }, type: "turn.started" },
    { data: { message: "Hi", turnId: "turn_0" }, type: "message.received" },
    {
      data: { message: "Hello.", turnId: "turn_0" },
      meta: { at: at(7) },
      type: "message.completed",
    },
  ]);
  const consumed = converted.find(
    (event) => event.type === "delivery.consumed"
  );
  assert.equal(consumed?.meta.at, at(5));
  const reply = converted.find(
    (event) =>
      event.type === "content.completed" &&
      (event.data as { kind?: string }).kind === "text"
  );
  assert.equal(reply?.meta.at, at(7));
});
