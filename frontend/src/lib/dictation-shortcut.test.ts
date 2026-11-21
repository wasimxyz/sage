import assert from "node:assert/strict";
import test from "node:test";

import {
  dictationTarget,
  isDictateKey,
  isInEditor,
  isStopKey,
} from "./dictation-shortcut.ts";

const plain = {
  altKey: false,
  code: "KeyD",
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

const escapeKey = {
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  isComposing: false,
  key: "Escape",
  metaKey: false,
  shiftKey: false,
};

test("command and D toggles dictation", () => {
  assert.equal(isDictateKey({ ...plain, metaKey: true }), true);
});

test("D alone, or with Ctrl, does not", () => {
  assert.equal(isDictateKey(plain), false);
  assert.equal(isDictateKey({ ...plain, ctrlKey: true }), false);
});

test("command and D with another modifier does not", () => {
  assert.equal(isDictateKey({ ...plain, altKey: true, metaKey: true }), false);
  assert.equal(
    isDictateKey({ ...plain, metaKey: true, shiftKey: true }),
    false
  );
  assert.equal(isDictateKey({ ...plain, ctrlKey: true, metaKey: true }), false);
});

test("a held command and D does not repeat", () => {
  assert.equal(isDictateKey({ ...plain, metaKey: true, repeat: true }), false);
});

test("command and another key does not", () => {
  assert.equal(isDictateKey({ ...plain, code: "KeyN", metaKey: true }), false);
});

test("Esc on its own stops dictation", () => {
  assert.equal(isStopKey(escapeKey), true);
});

test("Esc that something else handled does not", () => {
  assert.equal(isStopKey({ ...escapeKey, defaultPrevented: true }), false);
});

test("Esc in the editor stops dictation, though ProseMirror marks it handled", () => {
  assert.equal(isStopKey({ ...escapeKey, defaultPrevented: true }, true), true);
  assert.equal(
    isStopKey(
      { ...escapeKey, defaultPrevented: true, isComposing: true },
      true
    ),
    false
  );
});

test("isInEditor finds the editor around an event target", () => {
  const inside = {
    closest: (selector: string) => (selector === ".ProseMirror" ? {} : null),
  };
  const outside = { closest: () => null };
  assert.equal(isInEditor(inside), true);
  assert.equal(isInEditor(outside), false);
  assert.equal(isInEditor(null), false);
  assert.equal(isInEditor({}), false);
});

test("Esc that cancels an input method composition does not", () => {
  assert.equal(isStopKey({ ...escapeKey, isComposing: true }), false);
});

test("Esc with a modifier, or another key, does not", () => {
  assert.equal(isStopKey({ ...escapeKey, metaKey: true }), false);
  assert.equal(isStopKey({ ...escapeKey, shiftKey: true }), false);
  assert.equal(isStopKey({ ...escapeKey, key: "Enter" }), false);
});

test("Chat dictates into the message box", () => {
  assert.equal(dictationTarget("chat", false), "chat");
  assert.equal(dictationTarget("chat", true), "chat");
});

test("Journal dictates into the open entry", () => {
  assert.equal(dictationTarget("journal", true), "entry");
});

test("Journal with no entry open has nowhere to dictate", () => {
  assert.equal(dictationTarget("journal", false), null);
});

test("Home, Memories, and Settings have nowhere to dictate", () => {
  assert.equal(dictationTarget("home", true), null);
  assert.equal(dictationTarget("memories", true), null);
  assert.equal(dictationTarget("settings", true), null);
});
