import assert from "node:assert/strict";
import test from "node:test";

import { history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { Schema } from "@tiptap/pm/model";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";

import { clearHistory } from "./editor-history.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

// A plugin that keeps state, like the ones TipTap adds for decorations.
const keeperKey = new PluginKey<{ inits: number }>("keeper");
const keeper = new Plugin({
  key: keeperKey,
  state: {
    apply: (_tr, value) => value,
    init: () => ({ inits: 1 }),
  },
});

function docOf(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function stateWith(text: string) {
  return EditorState.create({
    doc: docOf(text),
    plugins: [history(), keeper],
  });
}

// What `setContent` does when an entry opens: replace everything.
function replaceDoc(state: EditorState, text: string) {
  return state.apply(
    state.tr.replaceWith(0, state.doc.content.size, docOf(text).content)
  );
}

function clear(state: EditorState) {
  return state.apply(clearHistory(state.tr));
}

function typeAt(state: EditorState, text: string, pos: number) {
  return state.apply(state.tr.insertText(text, pos));
}

test("replacing the document leaves it on the undo stack", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  assert.equal(undoDepth(opened), 1);
});

test("clearHistory keeps the document and empties the undo stack", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  const cleared = clear(opened);
  assert.equal(undoDepth(cleared), 0);
  assert.ok(cleared.doc.eq(opened.doc));
  assert.equal(cleared.doc.textContent, "Bravo");
});

test("clearHistory empties the redo stack too", () => {
  const typed = typeAt(replaceDoc(stateWith("Alpha"), "Bravo"), "!", 6);
  let undone = typed;
  undo(typed, (tr) => {
    undone = typed.apply(tr);
  });
  assert.equal(redoDepth(undone), 1);
  const cleared = clear(undone);
  assert.equal(redoDepth(cleared), 0);
  assert.equal(
    redo(cleared, () => undefined),
    false
  );
});

test("undo does nothing right after clearHistory", () => {
  const cleared = clear(replaceDoc(stateWith("Alpha"), "Bravo"));
  let dispatched = false;
  const handled = undo(cleared, () => {
    dispatched = true;
  });
  assert.equal(handled, false);
  assert.equal(dispatched, false);
});

test("typing after clearHistory can still be undone", () => {
  const cleared = clear(replaceDoc(stateWith("Alpha"), "Bravo"));
  const typed = typeAt(cleared, "!", 6);
  assert.equal(typed.doc.textContent, "Bravo!");
  assert.equal(undoDepth(typed), 1);
  let reverted = typed;
  undo(typed, (tr) => {
    reverted = typed.apply(tr);
  });
  assert.equal(reverted.doc.textContent, "Bravo");
});

test("clearHistory keeps the selection", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  const moved = opened.apply(
    opened.tr.setSelection(TextSelection.create(opened.doc, 3))
  );
  const cleared = clear(moved);
  assert.equal(cleared.selection.from, 3);
  assert.equal(cleared.selection.to, 3);
});

test("clearHistory does not change the document", () => {
  const state = replaceDoc(stateWith("Alpha"), "Bravo");
  assert.equal(clearHistory(state.tr).docChanged, false);
});

test("clearHistory leaves the plugin list and other plugin state alone", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  const cleared = clear(opened);
  assert.equal(cleared.plugins, opened.plugins);
  assert.equal(keeperKey.getState(cleared), keeperKey.getState(opened));
});
