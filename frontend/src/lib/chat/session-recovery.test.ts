import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientError,
  ClientSessionStrandedError,
  type EveAgentReducerEvent,
} from "eve/client";

import {
  isEndedSessionError,
  projectedMessageIdAtSeq,
} from "./session-recovery.ts";

const jsonHeaders = { "content-type": "application/json" };

function serverError(status: number, body: object): ClientError {
  return new ClientError(status, JSON.stringify(body), jsonHeaders);
}

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

test("isEndedSessionError accepts every way eve reports a dead session", () => {
  const ended = [
    serverError(409, {
      code: "session_not_active",
      error: "The session is no longer active.",
      ok: false,
    }),
    new ClientSessionStrandedError(
      409,
      JSON.stringify({
        code: "session_stranded",
        error: "The session was built by another eve version.",
        eveVersion: "0.66.3",
        ok: false,
      }),
      jsonHeaders,
      { eveVersion: "0.66.3" }
    ),
    serverError(410, {
      code: "session_expired",
      error: "The session history has expired.",
      ok: false,
    }),
    serverError(404, { error: "Session not found.", ok: false }),
  ];
  for (const error of ended) {
    assert.equal(isEndedSessionError(error), true, error.message);
  }
});

test("isEndedSessionError rejects other failures", () => {
  const live = [
    serverError(404, { error: "Not found.", ok: false }),
    serverError(409, { code: "turn_in_progress", error: "Busy.", ok: false }),
    serverError(503, { code: "session_expired", error: "Down.", ok: false }),
    new Error("Load failed"),
    "The session is no longer active.",
  ];
  for (const error of live) {
    assert.equal(isEndedSessionError(error), false, String(error));
  }
});

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
