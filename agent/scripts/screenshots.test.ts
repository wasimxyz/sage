import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedBridgeCommands,
  chatShots,
  checkBridgeCall,
  entryShots,
  hasModel,
  isQueuedCommandFile,
  isWindowPngSize,
  listedRows,
  lockRoute,
  lockShotName,
  newChatShot,
  pageZoomPercent,
  repeatSafeCommands,
  routeCommand,
  routePattern,
  securityShot,
  settingsShots,
  setupShots,
  shotSlug,
  syncCommand,
  zoomCommand,
} from "./screenshots.ts";

const entries = [
  { id: 13, title: "Sunday" },
  { id: 25, title: "Sunday, again" },
];
const chats = [
  { id: 1, title: "Show up as awkward instead of silent furniture" },
  {
    id: 3,
    title: "Focus on Jason staying while others checked out for toast.",
  },
];

test("every shot has its own name", () => {
  const names = [
    ...setupShots.map((shot) => shot.name),
    newChatShot.name,
    ...entryShots(entries).map((shot) => shot.name),
    ...chatShots(chats).map((shot) => shot.name),
    ...settingsShots.map((shot) => shot.name),
    securityShot.name,
    lockShotName,
  ];
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 15);
});

test("each entry and chat gets a shot named by its id and title", () => {
  assert.deepEqual(entryShots(entries), [
    { name: "entry-13-sunday", route: "/journal/13" },
    { name: "entry-25-sunday-again", route: "/journal/25" },
  ]);
  assert.deepEqual(chatShots(chats), [
    {
      name: "chat-1-show-up-as-awkward-instead-of-silent",
      route: "/chat/1",
    },
    {
      name: "chat-3-focus-on-jason-staying-while-others",
      route: "/chat/3",
    },
  ]);
  // Two rows with one title still get two files.
  const twins = entryShots([
    { id: 4, title: "Thursday" },
    { id: 5, title: "Thursday" },
  ]).map((shot) => shot.name);
  assert.deepEqual(twins, ["entry-4-thursday", "entry-5-thursday"]);
});

test("a title becomes lowercase words joined by dashes", () => {
  assert.equal(shotSlug("Sunday, again"), "sunday-again");
  assert.equal(shotSlug("Jason\u2019s wedding toast"), "jasons-wedding-toast");
  assert.equal(
    shotSlug("Feeling Overlooked After Quiet Launch"),
    "feeling-overlooked-after-quiet-launch"
  );
  assert.equal(shotSlug("  ...  "), "untitled");
  assert.equal(shotSlug(""), "untitled");
  assert.equal(shotSlug("a".repeat(60)).length, 40);
  assert.equal(shotSlug(`${"a".repeat(39)} b`), "a".repeat(39));
});

test("listed entries and chats come oldest id first, and need an id", () => {
  assert.deepEqual(
    listedRows([
      { id: 3, title: "C", updatedAt: "x" },
      { id: 1, title: "A" },
      { id: 2 },
    ]),
    [
      { id: 1, title: "A" },
      { id: 2, title: "" },
      { id: 3, title: "C" },
    ]
  );
  assert.deepEqual(listedRows([]), []);
  assert.throws(() => listedRows(undefined));
  assert.throws(() => listedRows([{ id: "3", title: "C" }]));
  assert.throws(() => listedRows([{ id: 0, title: "C" }]));
  assert.throws(() => listedRows([null]));
});

test("every route is one app.route accepts", () => {
  for (const shot of [
    newChatShot,
    ...entryShots(entries),
    ...chatShots(chats),
    ...settingsShots,
    securityShot,
  ]) {
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

test("the script sends only its own bridge commands", () => {
  for (const command of allowedBridgeCommands) {
    const payload = command === "lock.setTouchId" ? { enabled: true } : {};
    assert.doesNotThrow(() => checkBridgeCall(command, payload), command);
  }
  for (const command of [
    "journal.save",
    "journal.delete",
    "chat.save",
    "chat.delete",
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
  for (const prefix of ["app.route:", "app.appearance:", "app.zoom:"]) {
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

test("the shots zoom the page 10% and send a zoom app.zoom accepts", () => {
  assert.equal(pageZoomPercent, 110);
  assert.equal(zoomCommand(pageZoomPercent), "app.zoom:110");
  assert.equal(zoomCommand(50), "app.zoom:50");
  assert.equal(zoomCommand(200), "app.zoom:200");
  for (const percent of [49, 201, 110.5, Number.NaN, -110]) {
    assert.throws(() => zoomCommand(percent), String(percent));
  }
});

test("a capture must be the window at 1x or 2x", () => {
  assert.equal(isWindowPngSize(2560, 1600), true);
  assert.equal(isWindowPngSize(1280, 800), true);
  assert.equal(isWindowPngSize(3024, 1964), false);
  assert.equal(isWindowPngSize(2560, 1700), false);
});
