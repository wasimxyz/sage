import assert from "node:assert/strict";
import test from "node:test";

import {
  type ClientSessionState,
  conversationOf,
  SessionStore,
  type SessionStreamEvent,
} from "eve/client";

import {
  eventsToSaveAfterResume,
  focusMessageId,
  historyMessages,
  messageIdAtSeq,
  splitChatLog,
  splitSessions,
} from "./chat-log.ts";
import { convertChatEvents } from "./legacy-events.ts";
import { legacyRecoveredChat, legacySession } from "./test-chats.ts";

const chat = convertChatEvents(legacyRecoveredChat);
/** A saved session whose events are in the chat. */
const resumed: ClientSessionState = { sessionId: "sess_1", streamIndex: 9 };
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
  const log = splitChatLog(chat, resumed);
  assert.equal(log.history.length, secondStart);
  assert.equal(log.live[0]?.type, "session.started");
  assert.equal(log.history.length + log.live.length, chat.length);

  const ended = splitChatLog(chat, undefined);
  assert.equal(ended.history.length, chat.length);
  assert.equal(ended.live.length, 0);

  const single = splitChatLog(chat.slice(0, secondStart), resumed);
  assert.equal(single.history.length, 0);
});

test("splitChatLog keeps every event as history for a session saved at 0", () => {
  // Chat saves a new session's id before its events. If the app quit before
  // the turn finished, none of that session's events are in the chat.
  const log = splitChatLog(chat, { sessionId: "sess_2", streamIndex: 0 });
  assert.equal(log.history.length, chat.length);
  assert.equal(log.live.length, 0);
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
    messageIdAtSeq(chat, undefined, question, messages),
    messages[2]?.id
  );
  const reply = chat.findIndex(
    (event, index) =>
      index > secondStart &&
      event.type === "content.completed" &&
      (event.data as { kind?: string }).kind === "text"
  );
  assert.equal(
    messageIdAtSeq(chat, undefined, reply, messages),
    messages[3]?.id
  );
});

test("messageIdAtSeq finds a live session's message without a prefix", () => {
  const { history, live } = splitChatLog(chat, resumed);
  const messages = [
    ...historyMessages(history),
    ...conversationOf(live).messages,
  ];
  const question = seqOf("delivery.consumed", secondStart);
  const id = messageIdAtSeq(chat, resumed, question, messages);
  assert.equal(id, conversationOf(live).messages[0]?.id);
  assert.equal(id?.startsWith("history-"), false);
});

test("messageIdAtSeq is null for an event that shows no message", () => {
  const messages = historyMessages(chat);
  assert.equal(messageIdAtSeq(chat, undefined, 0, messages), null);
  assert.equal(messageIdAtSeq(chat, undefined, chat.length, messages), null);
  assert.equal(messageIdAtSeq(chat, undefined, -1, messages), null);
});

/**
 * A fake eve server that streams `events` as stored lines from the asked
 * start, then holds the stream open as a live session does.
 */
function serveSession(events: readonly SessionStreamEvent[]): number[] {
  const lines = new Map<number, { at: string; facts: unknown[] }>();
  for (const { meta, ...fact } of events) {
    const line = lines.get(meta.position.line) ?? { at: meta.at, facts: [] };
    line.facts.push(fact);
    lines.set(meta.position.line, line);
  }
  const count = Math.max(...lines.keys()) + 1;
  const starts: number[] = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    const start = Number(
      new URL(String(input)).searchParams.get("startIndex") ?? "0"
    );
    starts.push(start);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = start; index < count; index += 1) {
          const line = lines.get(index) ?? {
            $eve: "position",
            next: index + 1,
          };
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: {
          "x-eve-stream-tail-index": String(count - 1),
          "x-eve-stream-version": "27",
        },
        status: 200,
      })
    );
  };
  return starts;
}

test("a reopened chat saves the turn it missed", async () => {
  // On disk: one finished session, then a new session's id saved at 0. The
  // app quit before the new session's first turn finished. eve holds it.
  const saved = convertChatEvents(legacySession);
  const missed = convertChatEvents(legacySession);
  const session = { sessionId: "sess_2", streamIndex: 0 };
  const log = splitChatLog(saved, session);
  const realFetch = globalThis.fetch;
  const starts = serveSession(missed);

  let finished = 0;
  const store = new SessionStore({
    baseUrl: "http://127.0.0.1:1",
    initialEvents: log.live,
    initialSession: session,
  });
  store.setCallbacks({
    onFinish: () => {
      finished += 1;
    },
  });
  try {
    await store.resume();
    const { snapshot } = store;
    // The new session plays from its start, and eve reports no finished turn.
    assert.deepEqual(starts, [0]);
    assert.equal(snapshot.status, "idle");
    assert.equal(finished, 0);
    assert.deepEqual(
      snapshot.messages.map((message) => message.role),
      ["user", "assistant"]
    );

    const events = eventsToSaveAfterResume(
      log,
      snapshot.events,
      log.live.length
    );
    assert.equal(events?.length, saved.length + missed.length);
    assert.deepEqual(events?.slice(0, saved.length), saved);
    assert.equal(events?.[saved.length]?.type, "session.started");
    assert.equal(
      eventsToSaveAfterResume(log, snapshot.events, snapshot.events.length),
      null
    );
  } finally {
    store.newSession();
    globalThis.fetch = realFetch;
  }
});

test("focusMessageId finds a hit by its text when the chat was renumbered", () => {
  const messages = historyMessages(chat);
  const [, , , reply] = messages;
  const replyText = reply?.parts.find((part) => part.type === "text");
  assert.ok(replyText?.type === "text");
  const excerpt = `…${replyText.text.slice(2, 14)}…`;
  // The event at seq 0 shows no message, as an old number can after a
  // conversion. The excerpt still finds the reply.
  assert.equal(
    focusMessageId(chat, undefined, { seq: 0, text: excerpt }, messages),
    reply?.id
  );
  // A message at seq that holds the text wins over an earlier one.
  const question = chat.findIndex(
    (event, index) => index > secondStart && event.type === "delivery.consumed"
  );
  const asked = messages[2]?.parts.find((part) => part.type === "text");
  assert.ok(asked?.type === "text");
  assert.equal(
    focusMessageId(
      chat,
      undefined,
      { seq: question, text: asked.text },
      messages
    ),
    messages[2]?.id
  );
  // Text no message holds keeps the message at seq.
  assert.equal(
    focusMessageId(
      chat,
      undefined,
      { seq: question, text: "nowhere" },
      messages
    ),
    messages[2]?.id
  );
  assert.equal(
    focusMessageId(chat, undefined, { seq: question }, messages),
    messages[2]?.id
  );
});
