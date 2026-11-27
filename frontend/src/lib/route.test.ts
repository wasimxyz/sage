import assert from "node:assert/strict";
import test from "node:test";

import {
  isMemoriesTab,
  isNewChatSaved,
  isNewEntrySaved,
  isSettingsTab,
  navigationOverridesPendingMemoryRoute,
  parseHash,
  planChatRoute,
  routeForMemoryFeature,
  routeFromState,
  routesEqual,
  toHash,
} from "./route.ts";

const newChat = { chat: "new", section: "chat" } as const;

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

test("routeForMemoryFeature sends memory routes to a new chat only when disabled", () => {
  assert.deepEqual(
    routeForMemoryFeature({ section: "memories", tab: "events" }, false),
    newChat
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
  assert.equal(
    navigationOverridesPendingMemoryRoute(
      newChat,
      { entryId: 3, section: "journal" },
      false
    ),
    true
  );
  assert.equal(
    navigationOverridesPendingMemoryRoute(newChat, newChat, false),
    false
  );
  assert.equal(
    navigationOverridesPendingMemoryRoute(
      newChat,
      { entryId: 3, section: "journal" },
      true
    ),
    false
  );
});

test("Sage opens on a new chat, and bad hashes land there too", () => {
  for (const hash of [
    "",
    "#",
    "#/",
    "#/nowhere",
    "#/memories/topics",
    "#/memories/facts/extra",
  ]) {
    assert.deepEqual(parseHash(hash), newChat, hash);
  }
});

test("the old Home route opens a new chat", () => {
  assert.deepEqual(parseHash("#/home"), newChat);
  assert.deepEqual(parseHash("#/home/"), newChat);
});

test("parseHash opens a new entry for /journal and an entry for /journal/:id", () => {
  assert.deepEqual(parseHash("#/journal"), {
    entryId: null,
    section: "journal",
  });
  assert.deepEqual(parseHash("#/journal/7"), {
    entryId: 7,
    section: "journal",
  });
  assert.deepEqual(parseHash("#/journal/0"), newChat);
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
      entryId: null,
      memoriesTab: "facts",
      section: "memories",
      settingsOpen: false,
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
  assert.deepEqual(parseHash("#/settings/unknown"), newChat);
});

test("toHash leaves the Agent tab off the settings hash", () => {
  assert.equal(toHash({ section: "settings", tab: "agent" }), "/settings");
  assert.equal(
    toHash({ section: "settings", tab: "security" }),
    "/settings/security"
  );
  assert.equal(toHash(parseHash("#/settings/agent")), "/settings");
});

test("routeFromState is Settings while its dialog is open over a screen", () => {
  const open = {
    chatId: 4,
    entryId: 9,
    memoriesTab: "facts",
    settingsTab: "data",
  } as const;
  for (const section of ["chat", "journal", "memories"] as const) {
    assert.deepEqual(routeFromState({ ...open, section, settingsOpen: true }), {
      section: "settings",
      tab: "data",
    });
  }
  // Closing the dialog leaves the screen under it.
  assert.deepEqual(
    routeFromState({ ...open, section: "journal", settingsOpen: false }),
    { entryId: 9, section: "journal" }
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

test("parseHash maps chat hashes onto a new chat and a saved chat", () => {
  assert.deepEqual(parseHash("#/chat/new"), newChat);
  assert.deepEqual(parseHash("#/chat/12"), { chat: 12, section: "chat" });
  assert.deepEqual(parseHash("#/chat/0"), newChat);
  assert.deepEqual(parseHash("#/chat/other"), newChat);
  assert.deepEqual(parseHash("#/chat/12/extra"), newChat);
});

test("the old chat list route opens a new chat", () => {
  assert.deepEqual(parseHash("#/chat"), newChat);
  assert.equal(toHash(parseHash("#/chat")), "/chat/new");
});

test("toHash writes each chat view and parses back to the same place", () => {
  assert.equal(toHash(newChat), "/chat/new");
  assert.equal(toHash({ chat: 12, section: "chat" }), "/chat/12");
  for (const hash of ["#/chat/new", "#/chat/12"]) {
    assert.equal(`#${toHash(parseHash(hash))}`, hash);
  }
});

test("routeFromState shows the chat or entry each tab has open", () => {
  const base = {
    memoriesTab: "facts",
    settingsOpen: false,
    settingsTab: "agent",
  } as const;
  // Switching tabs changes only the section. Each tab's open item comes back.
  const open = { ...base, chatId: 4, entryId: 9 };
  assert.deepEqual(routeFromState({ ...open, section: "chat" }), {
    chat: 4,
    section: "chat",
  });
  assert.deepEqual(routeFromState({ ...open, section: "journal" }), {
    entryId: 9,
    section: "journal",
  });
  const fresh = { ...base, chatId: null, entryId: null };
  assert.deepEqual(routeFromState({ ...fresh, section: "chat" }), newChat);
  assert.deepEqual(routeFromState({ ...fresh, section: "journal" }), {
    entryId: null,
    section: "journal",
  });
});

test("isNewChatSaved is true only when a new chat becomes a saved one", () => {
  const saved = { chat: 5, section: "chat" } as const;
  assert.equal(isNewChatSaved(newChat, saved), true);
  assert.equal(isNewChatSaved({ chat: 4, section: "chat" }, saved), false);
  assert.equal(isNewChatSaved(saved, newChat), false);
  assert.equal(isNewChatSaved(null, saved), false);
  assert.equal(
    isNewChatSaved({ entryId: null, section: "journal" }, saved),
    false
  );
});

test("isNewEntrySaved is true only when a new entry becomes a saved one", () => {
  const draft = { entryId: null, section: "journal" } as const;
  const saved = { entryId: 5, section: "journal" } as const;
  assert.equal(isNewEntrySaved(draft, saved), true);
  assert.equal(
    isNewEntrySaved({ entryId: 4, section: "journal" }, saved),
    false
  );
  assert.equal(isNewEntrySaved(saved, draft), false);
  assert.equal(isNewEntrySaved(null, saved), false);
  assert.equal(isNewEntrySaved(newChat, saved), false);
});

test("planChatRoute keeps the chat that is already open, and shows Chat if needed", () => {
  assert.deepEqual(
    planChatRoute("new", { onChat: true, selection: { kind: "new" } }),
    { afterShow: "keep", showChat: false }
  );
  assert.deepEqual(
    planChatRoute(7, { onChat: false, selection: { id: 7, kind: "saved" } }),
    { afterShow: "keep", showChat: true }
  );
});

test("planChatRoute starts a new chat or opens another one when the selection differs", () => {
  assert.deepEqual(
    planChatRoute("new", {
      onChat: false,
      selection: { id: 7, kind: "saved" },
    }),
    { afterShow: "new-chat", showChat: true }
  );
  assert.deepEqual(
    planChatRoute(8, { onChat: true, selection: { id: 7, kind: "saved" } }),
    { afterShow: { open: 8 }, showChat: false }
  );
  assert.deepEqual(
    planChatRoute(8, { onChat: true, selection: { kind: "new" } }),
    { afterShow: { open: 8 }, showChat: false }
  );
});
