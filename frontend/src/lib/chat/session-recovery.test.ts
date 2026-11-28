import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientError,
  ClientSessionStrandedError,
  SessionNotActiveError,
} from "eve/client";

import { convertChatEvents } from "./legacy-events.ts";
import {
  buildHistoryTranscript,
  historyClientContext,
  isEndedSessionError,
} from "./session-recovery.ts";
import { legacyRecoveredChat } from "./test-chats.ts";

const jsonHeaders = { "content-type": "application/json" };

function serverError(status: number, body: object): ClientError {
  return new ClientError(status, JSON.stringify(body), jsonHeaders);
}

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
    new SessionNotActiveError(),
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
    new SessionNotActiveError({ retryable: true }),
    "The session is no longer active.",
  ];
  for (const error of live) {
    assert.equal(isEndedSessionError(error), false, String(error));
  }
});

test("buildHistoryTranscript lists what you and Sage said in every session", () => {
  assert.equal(
    buildHistoryTranscript(convertChatEvents(legacyRecoveredChat)),
    [
      "**User**\nHow did I sleep last week?",
      "**Assistant**\nNothing from last week.",
      "**User**\nAnd the week before?",
      "**Assistant**\nYou slept well.",
    ].join("\n\n")
  );
});

test("buildHistoryTranscript keeps the newest turns past the limit", () => {
  const long = "word ".repeat(1200);
  const events = convertChatEvents([
    { data: { message: long }, type: "message.received" },
    { data: { message: long }, type: "message.completed" },
    { data: { message: long }, type: "message.received" },
    { data: { message: "The newest reply." }, type: "message.completed" },
  ]);
  const transcript = buildHistoryTranscript(events);
  assert.equal(transcript.startsWith("_Earlier messages were omitted._"), true);
  assert.equal(transcript.endsWith("**Assistant**\nThe newest reply."), true);
  assert.equal(
    new TextEncoder().encode(transcript).byteLength <= 12 * 1024,
    true
  );
});

test("historyClientContext is empty for a chat with nothing said", () => {
  assert.equal(historyClientContext([]), undefined);
  assert.equal(
    historyClientContext(convertChatEvents(legacyRecoveredChat))?.startsWith(
      "The earlier conversation was restored"
    ),
    true
  );
});
