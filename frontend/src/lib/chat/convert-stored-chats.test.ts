import assert from "node:assert/strict";
import test from "node:test";

import {
  convertStoredChat,
  convertStoredChats,
  onChatConverted,
  startStoredChatsPass,
  storedChatsPassDone,
} from "./convert-stored-chats.ts";
import { installFakeChatCore } from "./fake-chat-core.ts";
import { isConvertedLog } from "./legacy-events.ts";
import { legacySession } from "./test-chats.ts";

const core = installFakeChatCore();
const notFound = /NotFound/u;

function addLegacyChat(id: number): void {
  core.chats.set(id, {
    eventFormat: 26,
    events: structuredClone(legacySession),
  });
}

function convertSaves(id: number): number {
  return core.saves.filter(
    (save) => save.convert && save.id === id && save.done
  ).length;
}

test("the pass at launch and opening a chat share one conversion", async () => {
  addLegacyChat(1);
  await Promise.all([convertStoredChat(1), convertStoredChat(1)]);
  assert.equal(convertSaves(1), 1);
  assert.equal(core.chats.get(1)?.eventFormat, 27);
  assert.equal(isConvertedLog(core.chats.get(1)?.events ?? []), true);
});

test("a chat that fails stays for the next pass, and the pass goes on", async () => {
  addLegacyChat(2);
  addLegacyChat(3);
  core.failNextSave(2, "SqliteWriteFailed");
  await convertStoredChats();
  assert.equal(core.chats.get(2)?.eventFormat, 26);
  assert.deepEqual(core.chats.get(2)?.events, legacySession);
  assert.equal(core.chats.get(3)?.eventFormat, 27);

  await convertStoredChats();
  assert.equal(core.chats.get(2)?.eventFormat, 27);
});

test("a chat already converted is left alone", async () => {
  core.chats.set(4, { eventFormat: 27, events: [] });
  const before = core.saves.length;
  await convertStoredChat(4);
  assert.equal(core.saves.length, before);
});

test("a refusal because the chat is converted counts as done", async () => {
  addLegacyChat(5);
  // Another window converted it between the read and the save.
  core.failNextSave(5, "ChatConverted");
  await convertStoredChat(5);
});

test("a chat deleted while it converts fails only its own conversion", async () => {
  addLegacyChat(6);
  addLegacyChat(7);
  core.failNextSave(6, "NotFound");
  await assert.rejects(convertStoredChat(6), notFound);
  core.failNextSave(6, "NotFound");
  await convertStoredChats();
  assert.equal(core.chats.get(7)?.eventFormat, 27);
});

test("each converted chat is announced, so it can be indexed again", async () => {
  addLegacyChat(8);
  core.chats.set(9, { eventFormat: 27, events: [] });
  const heard: number[] = [];
  const stop = onChatConverted((id) => heard.push(id));
  try {
    await convertStoredChat(8);
    await convertStoredChat(9);
  } finally {
    stop();
  }
  assert.deepEqual(heard, [8]);
});

test("a message sent before the pass at launch ends waits for it", async () => {
  addLegacyChat(10);
  const gate: { open?: () => void } = {};
  const listLoaded = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const pass = startStoredChatsPass(listLoaded);
  let waited = false;
  const send = storedChatsPassDone().then(() => {
    waited = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(waited, false);
  gate.open?.();
  await send;
  assert.equal(core.chats.get(10)?.eventFormat, 27);
  await pass;
});
