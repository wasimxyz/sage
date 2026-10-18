import assert from "node:assert/strict";
import test from "node:test";

import {
  isMemoriesTab,
  isNewChatSaved,
  isSettingsTab,
  navigationOverridesPendingMemoryRoute,
  parseHash,
  routeForMemoryFeature,
  routeFromState,
  routesEqual,
  toHash,
} from "./route.ts";

test("parseHash maps memories hashes onto Facts and Events", () => {
  assert.deepEqual(parseHash("#/memories"), {
    section: "memories",
    tab: "facts",
  });
  assert.deepEqual(parseHash("#/memories/facts"), {
    section: "memories",
    tab: "facts",
  });
  assert.deepEqual(parseHash("#/memories/profile"), {
    section: "memories",
    tab: "facts",
  });
  assert.deepEqual(parseHash("#/memories/events"), {
    section: "memories",
    tab: "events",
  });
});

test("routeForMemoryFeature redirects memory routes only when disabled", () => {
  assert.deepEqual(
    routeForMemoryFeature({ section: "memories", tab: "events" }, false),
    { section: "home" }
  );
  assert.deepEqual(
    routeForMemoryFeature({ section: "memories", tab: "events" }, true),
    { section: "memories", tab: "events" }
  );
  assert.deepEqual(
    routeForMemoryFeature({ entryId: null, section: "journal" }, false),
    { entryId: null, section: "journal" }
  );
});

test("navigation during a delayed memory check overrides the startup hash", () => {
  const initial = { section: "home" } as const;
  assert.equal(
    navigationOverridesPendingMemoryRoute(
      initial,
      { chat: "list", section: "chat" },
      false
    ),
    true
  );
  assert.equal(
    navigationOverridesPendingMemoryRoute(initial, initial, false),
    false
  );
  assert.equal(
    navigationOverridesPendingMemoryRoute(
      initial,
      { chat: "list", section: "chat" },
      true
    ),
    false
  );
});

test("parseHash opens Home for an empty hash and treats bad hashes as Home", () => {
  assert.deepEqual(parseHash(""), { section: "home" });
  assert.deepEqual(parseHash("#"), { section: "home" });
  assert.deepEqual(parseHash("#/"), { section: "home" });
  assert.deepEqual(parseHash("#/nowhere"), { section: "home" });
  assert.deepEqual(parseHash("#/memories/topics"), { section: "home" });
  assert.deepEqual(parseHash("#/memories/facts/extra"), { section: "home" });
});

test("parseHash still opens the Journal when the hash asks for it", () => {
  assert.deepEqual(parseHash("#/journal"), {
    entryId: null,
    section: "journal",
  });
  assert.deepEqual(parseHash("#/journal/7"), {
    entryId: 7,
    section: "journal",
  });
});

test("toHash writes Facts as /memories and Events with a suffix", () => {
  assert.equal(toHash({ section: "memories", tab: "facts" }), "/memories");
  assert.equal(
    toHash({ section: "memories", tab: "events" }),
    "/memories/events"
  );
  assert.equal(toHash(parseHash("#/memories/profile")), "/memories");
  assert.equal(toHash(parseHash("#/memories/facts")), "/memories");
});

test("routeFromState keeps the Memories tab", () => {
  assert.deepEqual(
    routeFromState({
      chatId: null,
      chatPanelOpen: true,
      detailOpen: false,
      entryId: null,
      memoriesTab: "facts",
      section: "memories",
      settingsTab: "agent",
    }),
    { section: "memories", tab: "facts" }
  );
});

test("parseHash maps settings hashes onto their tabs", () => {
  assert.deepEqual(parseHash("#/settings"), {
    section: "settings",
    tab: "agent",
  });
  assert.deepEqual(parseHash("#/settings/agent"), {
    section: "settings",
    tab: "agent",
  });
  assert.deepEqual(parseHash("#/settings/models"), {
    section: "settings",
    tab: "models",
  });
  assert.deepEqual(parseHash("#/settings/security"), {
    section: "settings",
    tab: "security",
  });
  assert.deepEqual(parseHash("#/settings/data"), {
    section: "settings",
    tab: "data",
  });
  assert.deepEqual(parseHash("#/settings/unknown"), { section: "home" });
});

test("toHash leaves the Agent tab off the settings hash", () => {
  assert.equal(toHash({ section: "settings", tab: "agent" }), "/settings");
  assert.equal(
    toHash({ section: "settings", tab: "security" }),
    "/settings/security"
  );
  assert.equal(toHash(parseHash("#/settings/agent")), "/settings");
});

test("routeFromState keeps the settings tab", () => {
  assert.deepEqual(
    routeFromState({
      chatId: 4,
      chatPanelOpen: true,
      detailOpen: true,
      entryId: 9,
      memoriesTab: "facts",
      section: "settings",
      settingsTab: "data",
    }),
    { section: "settings", tab: "data" }
  );
});

test("isSettingsTab accepts only the four settings tabs", () => {
  for (const tab of ["agent", "models", "security", "data"]) {
    assert.equal(isSettingsTab(tab), true);
  }
  assert.equal(isSettingsTab("memories"), false);
  assert.equal(isSettingsTab(null), false);
});

test("routesEqual treats Facts hashes as the same place", () => {
  assert.equal(
    routesEqual(parseHash("#/memories"), parseHash("#/memories/facts")),
    true
  );
  assert.equal(
    routesEqual(parseHash("#/memories"), parseHash("#/memories/profile")),
    true
  );
  assert.equal(
    routesEqual(parseHash("#/memories"), parseHash("#/memories/events")),
    false
  );
});

test("isMemoriesTab accepts only Facts and Events", () => {
  assert.equal(isMemoriesTab("facts"), true);
  assert.equal(isMemoriesTab("events"), true);
  assert.equal(isMemoriesTab("profile"), false);
  assert.equal(isMemoriesTab("topics"), false);
  assert.equal(isMemoriesTab(null), false);
});

test("parseHash maps chat hashes onto the list, a new chat, and a saved chat", () => {
  assert.deepEqual(parseHash("#/chat"), { chat: "list", section: "chat" });
  assert.deepEqual(parseHash("#/chat/new"), { chat: "new", section: "chat" });
  assert.deepEqual(parseHash("#/chat/12"), { chat: 12, section: "chat" });
  assert.deepEqual(parseHash("#/chat/0"), { section: "home" });
  assert.deepEqual(parseHash("#/chat/other"), { section: "home" });
  assert.deepEqual(parseHash("#/chat/12/extra"), { section: "home" });
});

test("toHash writes each chat view and parses back to the same place", () => {
  assert.equal(toHash({ chat: "list", section: "chat" }), "/chat");
  assert.equal(toHash({ chat: "new", section: "chat" }), "/chat/new");
  assert.equal(toHash({ chat: 12, section: "chat" }), "/chat/12");
  for (const hash of ["#/chat", "#/chat/new", "#/chat/12"]) {
    assert.equal(`#${toHash(parseHash(hash))}`, hash);
  }
});

test("routeFromState shows the list alone while the chat panel is closed", () => {
  const base = {
    detailOpen: false,
    entryId: null,
    memoriesTab: "facts",
    section: "chat",
    settingsTab: "agent",
  } as const;
  assert.deepEqual(
    routeFromState({ ...base, chatId: 4, chatPanelOpen: false }),
    { chat: "list", section: "chat" }
  );
  assert.deepEqual(
    routeFromState({ ...base, chatId: null, chatPanelOpen: true }),
    { chat: "new", section: "chat" }
  );
  assert.deepEqual(
    routeFromState({ ...base, chatId: 4, chatPanelOpen: true }),
    {
      chat: 4,
      section: "chat",
    }
  );
});

test("isNewChatSaved is true only when a new chat becomes a saved one", () => {
  const fresh = { chat: "new", section: "chat" } as const;
  const saved = { chat: 5, section: "chat" } as const;
  const list = { chat: "list", section: "chat" } as const;
  assert.equal(isNewChatSaved(fresh, saved), true);
  assert.equal(isNewChatSaved(list, saved), false);
  assert.equal(isNewChatSaved(saved, fresh), false);
  assert.equal(isNewChatSaved(null, saved), false);
  assert.equal(isNewChatSaved({ section: "home" }, saved), false);
});
