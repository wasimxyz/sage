import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { defaultMessageReducer, type EveAgentReducerEvent } from "eve/client";

import { loadEntryFiles } from "../evals/lib/dataset.ts";

import {
  chatAnswer,
  chatQuestion,
  chatSourceFiles,
  screenshotChat,
  screenshotChatEvents,
} from "./screenshot-chat.ts";
import {
  allowedBridgeCommands,
  appShots,
  checkBridgeCall,
  findSavedId,
  hasModel,
  isQueuedCommandFile,
  isWindowPngSize,
  journalShotFile,
  lockRoute,
  lockShotName,
  maxChunkBytes,
  oneChunk,
  repeatSafeCommands,
  routeCommand,
  routePattern,
  securityShot,
  setupShots,
  syncCommand,
} from "./screenshots.ts";

const seedDir = join(import.meta.dirname, "..", "..", "scripts", "seed");
const ids = { chat: 4, journalEntry: 25 };

test("every shot has its own name", () => {
  const names = [
    ...setupShots.map((shot) => shot.name),
    ...appShots(ids).map((shot) => shot.name),
    securityShot.name,
    lockShotName,
  ];
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 13);
});

test("every route is one app.route accepts", () => {
  for (const shot of [...appShots(ids), securityShot]) {
    assert.match(shot.route, routePattern, shot.name);
  }
  assert.match(lockRoute, routePattern);
  for (const bad of ["", "/", "chat", "/Chat", "/chat//3", '/chat/"x']) {
    assert.doesNotMatch(bad, routePattern, bad);
  }
});

test("a route goes to Sage with dots for slashes", () => {
  assert.equal(routeCommand("/chat/3"), "app.route:chat.3");
  assert.equal(routeCommand("/settings/models"), "app.route:settings.models");
  assert.equal(routeCommand("/chat/new"), "app.route:chat.new");
  assert.equal(routeCommand("/journal"), "app.route:journal");
  assert.throws(() => routeCommand(`/${"a".repeat(64)}`));
  assert.throws(() => routeCommand("chat"));
});

test("the files the shots name are in the seed", () => {
  for (const fileName of [journalShotFile, ...chatSourceFiles]) {
    assert.ok(existsSync(join(seedDir, fileName)), fileName);
  }
});

test("the script sends only its own bridge commands", () => {
  for (const command of allowedBridgeCommands) {
    const payload = command === "lock.setTouchId" ? { enabled: true } : {};
    assert.doesNotThrow(() => checkBridgeCall(command, payload), command);
  }
  for (const command of [
    "lock.disable",
    "lock.removePassword",
    "encryption.enable",
    "encryption.disable",
    "data.deleteAll",
    "dream.start",
    "ollama.pull",
  ]) {
    assert.throws(() => checkBridgeCall(command, {}), command);
  }
});

test("only commands that change nothing when repeated are sent again", () => {
  for (const command of repeatSafeCommands) {
    assert.ok(
      (allowedBridgeCommands as readonly string[]).includes(command),
      command
    );
  }
  for (const command of ["journal.save", "chat.save", "lock.setPassword"]) {
    assert.equal(repeatSafeCommands.has(command), false, command);
  }
});

test("Touch ID only ever turns on", () => {
  assert.throws(() => checkBridgeCall("lock.setTouchId", { enabled: false }));
  assert.throws(() => checkBridgeCall("lock.setTouchId", {}));
});

test("every seed entry and the chat save in one call", async () => {
  for (const entry of await loadEntryFiles(seedDir)) {
    assert.doesNotThrow(() => oneChunk(entry.body, entry.fileName));
  }
  const sources = chatSourceFiles.map((fileName, index) => ({
    date: "2026-11-01",
    id: index + 1,
    title: fileName,
  }));
  const chat = screenshotChat(sources, new Date(0));
  assert.doesNotThrow(() => oneChunk(JSON.stringify(chat.events), "chat"));
  assert.throws(() => oneChunk("x".repeat(maxChunkBytes + 1), "long"));
  assert.throws(() => oneChunk("é".repeat(maxChunkBytes / 2 + 1), "long"));
});

test("a lost save is found only when exactly one row matches", () => {
  const rows = [
    { date: "2026-11-01", id: 3, title: "Sunday" },
    { date: "2026-11-02", id: 4, title: "Monday" },
    { date: "2026-11-02", id: 5, title: "Monday" },
  ];
  const byTitle = (title: string) => (row: Record<string, unknown>) =>
    row.title === title;
  assert.equal(findSavedId(rows, byTitle("Sunday")), 3);
  assert.equal(findSavedId(rows, byTitle("Monday")), null);
  assert.equal(findSavedId(rows, byTitle("Tuesday")), null);
  assert.equal(findSavedId(undefined, byTitle("Sunday")), null);
  assert.equal(
    findSavedId([{ id: "3", title: "Sunday" }], byTitle("Sunday")),
    null
  );
});

test("a model counts as installed the way the Local AI step counts it", () => {
  assert.equal(hasModel(["qwen3.5:9b"], "qwen3.5:9b"), true);
  assert.equal(hasModel(["qwen3.5:9b-q8_0"], "qwen3.5:9b"), true);
  assert.equal(hasModel(["nomic-embed-text:latest"], "nomic-embed-text"), true);
  assert.equal(hasModel(["nomic-embed-text:v1.5"], "nomic-embed-text"), true);
  assert.equal(hasModel(["qwen3.5:4b"], "qwen3.5:9b"), false);
  assert.equal(hasModel(["qwen3.5"], "qwen3.5:9b"), false);
  assert.equal(hasModel([], "qwen3.5:9b"), false);
});

test("the sync command is one Sage does nothing with", () => {
  for (const prefix of ["app.route:", "app.appearance:"]) {
    assert.equal(syncCommand.startsWith(prefix), false, prefix);
  }
  for (const command of [
    "app.lock",
    "app.settings",
    "app.import",
    "app.export",
  ]) {
    assert.notEqual(syncCommand, command);
  }
});

test("only command-<n>.txt files are queued commands", () => {
  assert.equal(isQueuedCommandFile("command-12.txt"), true);
  for (const name of [
    "snapshot.txt",
    "bridge-response.txt",
    "command-.txt",
    "command-1.txt.tmp",
    "command-x.txt",
  ]) {
    assert.equal(isQueuedCommandFile(name), false, name);
  }
});

test("a capture must be the window at 1x or 2x", () => {
  assert.equal(isWindowPngSize(2560, 1600), true);
  assert.equal(isWindowPngSize(1280, 800), true);
  assert.equal(isWindowPngSize(3024, 1964), false);
  assert.equal(isWindowPngSize(2560, 1700), false);
});

test("the stored chat replays as a question, a search card, and an answer", () => {
  const sources = [
    { date: "2026-10-11", id: 13, title: "Sunday" },
    { date: "2026-10-25", id: 17, title: "First Sunday call" },
    { date: "2026-11-08", id: 25, title: "Sunday, again" },
  ];
  const events = screenshotChatEvents(
    sources,
    new Date("2026-11-22T12:00:00Z")
  ) as EveAgentReducerEvent[];
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  for (const event of events) {
    data = reducer.reduce(data, event);
  }

  const [user, assistant] = data.messages;
  assert.equal(data.messages.length, 2);
  assert.equal(user?.role, "user");
  assert.deepEqual(
    user?.parts.filter((part) => part.type === "text").map((part) => part.text),
    [chatQuestion]
  );

  assert.equal(assistant?.role, "assistant");
  const tool = assistant?.parts.find((part) => part.type === "dynamic-tool");
  assert.equal(tool?.type, "dynamic-tool");
  if (tool?.type === "dynamic-tool") {
    assert.equal(tool.toolName, "search_journal");
    assert.equal(tool.state, "output-available");
    assert.deepEqual(tool.output, [
      { date: "2026-10-11", id: "entry-13", title: "Sunday" },
      { date: "2026-10-25", id: "entry-17", title: "First Sunday call" },
      { date: "2026-11-08", id: "entry-25", title: "Sunday, again" },
    ]);
  }
  const text = assistant?.parts.find((part) => part.type === "text");
  assert.equal(text?.type === "text" ? text.text : null, chatAnswer);
});

test("every stored event has its own id", () => {
  const events = screenshotChatEvents([], new Date()) as {
    meta: { id: string };
  }[];
  const eventIds = events.map((event) => event.meta.id);
  assert.equal(new Set(eventIds).size, eventIds.length);
});
