import assert from "node:assert/strict";
import test from "node:test";

import {
  chatTabSection,
  sidebarActions,
  tabForSection,
} from "./sidebar-tab.ts";

test("Chat and Memories belong to the Chat tab, Journal to its own", () => {
  assert.equal(tabForSection("chat"), "chat");
  assert.equal(tabForSection("memories"), "chat");
  assert.equal(tabForSection("journal"), "journal");
});

test("the Chat tab goes back to the screen last open in it", () => {
  assert.equal(chatTabSection("chat", true), "chat");
  assert.equal(chatTabSection("memories", true), "memories");
});

test("the Chat tab never goes to Memories without memory", () => {
  assert.equal(chatTabSection("memories", false), "chat");
});

test("the Chat tab has New chat, Search, and Memories in a memory build", () => {
  assert.deepEqual(sidebarActions("chat", true), [
    "new-chat",
    "search",
    "memories",
  ]);
});

test("Memories shows only in a memory build", () => {
  assert.deepEqual(sidebarActions("chat", false), ["new-chat", "search"]);
});

test("the Journal tab has New entry, Search, and Import", () => {
  const expected = ["new-entry", "search", "import"];
  assert.deepEqual(sidebarActions("journal", true), expected);
  assert.deepEqual(sidebarActions("journal", false), expected);
});

test("the rows are the same list each time, so a render keeps them", () => {
  assert.equal(sidebarActions("chat", true), sidebarActions("chat", true));
  assert.equal(
    sidebarActions("journal", false),
    sidebarActions("journal", true)
  );
});
