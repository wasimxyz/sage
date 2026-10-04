import assert from "node:assert/strict";
import test from "node:test";

import type { EveAgentReducerEvent } from "eve/client";

import { projectedMessageIdAtSeq } from "./session-recovery.ts";

const userReceived = {
  data: { message: "Hello Sage", turnId: "turn_0" },
  type: "message.received",
} as EveAgentReducerEvent;

const assistantCompleted = {
  data: { finishReason: "stop", message: "The fog lifted.", turnId: "turn_0" },
  type: "message.completed",
} as EveAgentReducerEvent;

const turnCompleted = {
  data: { turnId: "turn_0" },
  type: "turn.completed",
} as EveAgentReducerEvent;

const sessionFailed = {
  data: { error: { message: "down" } },
  type: "session.failed",
} as EveAgentReducerEvent;

test("projectedMessageIdAtSeq maps a user message.received", () => {
  assert.equal(projectedMessageIdAtSeq([userReceived], 0), "turn_0:user");
});

test("projectedMessageIdAtSeq maps an assistant message.completed", () => {
  assert.equal(
    projectedMessageIdAtSeq([userReceived, assistantCompleted], 1),
    "turn_0:assistant"
  );
});

test("projectedMessageIdAtSeq namespaces a reused turn id", () => {
  const events = [
    userReceived,
    turnCompleted,
    {
      data: { message: "Again", turnId: "turn_0" },
      type: "message.received",
    } as EveAgentReducerEvent,
  ];
  assert.equal(projectedMessageIdAtSeq(events, 0), "turn_0:user");
  assert.equal(projectedMessageIdAtSeq(events, 2), "turn_0#1:user");
});

test("projectedMessageIdAtSeq returns null for a non-message seq", () => {
  assert.equal(projectedMessageIdAtSeq([userReceived, sessionFailed], 1), null);
  assert.equal(projectedMessageIdAtSeq([userReceived], 4), null);
  assert.equal(projectedMessageIdAtSeq([userReceived], -1), null);
});

test("projectedMessageIdAtSeq uses meta.id when the stream stamped one", () => {
  const stamped = {
    data: { message: "Hello Sage", sequence: 0, turnId: "turn_0" },
    meta: { at: "2026-09-23T00:00:00.000Z", id: "evt_hello" },
    type: "message.received",
  } as EveAgentReducerEvent;
  assert.equal(projectedMessageIdAtSeq([stamped], 0), "evt_hello:user");
});
