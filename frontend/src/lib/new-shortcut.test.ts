import assert from "node:assert/strict";
import test from "node:test";

import { isNewKey, newTarget } from "./new-shortcut.ts";

const plain = {
  altKey: false,
  code: "KeyN",
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

test("command and N starts something", () => {
  assert.equal(isNewKey({ ...plain, metaKey: true }), true);
});

test("N alone, or with Ctrl, does not", () => {
  assert.equal(isNewKey(plain), false);
  assert.equal(isNewKey({ ...plain, ctrlKey: true }), false);
});

test("command and N with another modifier does not", () => {
  assert.equal(isNewKey({ ...plain, altKey: true, metaKey: true }), false);
  assert.equal(isNewKey({ ...plain, metaKey: true, shiftKey: true }), false);
});

test("a held command and N does not repeat", () => {
  assert.equal(isNewKey({ ...plain, metaKey: true, repeat: true }), false);
});

test("command and another key does not", () => {
  assert.equal(isNewKey({ ...plain, code: "KeyM", metaKey: true }), false);
});

test("Chat starts a chat", () => {
  assert.equal(newTarget("chat", false), "chat");
});

test("Home, Journal, and Memories start an entry", () => {
  assert.equal(newTarget("home", false), "entry");
  assert.equal(newTarget("journal", false), "entry");
  assert.equal(newTarget("memories", false), "entry");
});

test("Memories starts nothing while a memory is open for editing", () => {
  assert.equal(newTarget("memories", true), null);
});

test("Settings starts nothing", () => {
  assert.equal(newTarget("settings", false), null);
});
