import assert from "node:assert/strict";
import test from "node:test";

import { history, undo, undoDepth } from "@tiptap/pm/history";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import { withEmptyHistory } from "./editor-history.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

function docOf(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function stateWith(text: string) {
  return EditorState.create({ doc: docOf(text), plugins: [history()] });
}

// What `setContent` does when an entry opens: replace everything.
function replaceDoc(state: EditorState, text: string) {
  return state.apply(
    state.tr.replaceWith(0, state.doc.content.size, docOf(text).content)
  );
}

test("replacing the document leaves it on the undo stack", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  assert.equal(undoDepth(opened), 1);
});

test("withEmptyHistory keeps the document and clears the undo stack", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  const cleared = withEmptyHistory(opened);
  assert.equal(undoDepth(cleared), 0);
  assert.ok(cleared.doc.eq(opened.doc));
  assert.equal(cleared.doc.textContent, "Bravo");
});

test("undo does nothing right after withEmptyHistory", () => {
  const cleared = withEmptyHistory(replaceDoc(stateWith("Alpha"), "Bravo"));
  let dispatched = false;
  const handled = undo(cleared, () => {
    dispatched = true;
  });
  assert.equal(handled, false);
  assert.equal(dispatched, false);
});

test("typing after withEmptyHistory can still be undone", () => {
  const cleared = withEmptyHistory(replaceDoc(stateWith("Alpha"), "Bravo"));
  const typed = cleared.apply(cleared.tr.insertText("!", 6));
  assert.equal(typed.doc.textContent, "Bravo!");
  assert.equal(undoDepth(typed), 1);
  let reverted: EditorState | null = null;
  undo(typed, (tr) => {
    reverted = typed.apply(tr);
  });
  assert.equal((reverted as EditorState | null)?.doc.textContent, "Bravo");
});

test("withEmptyHistory keeps the selection", () => {
  const opened = replaceDoc(stateWith("Alpha"), "Bravo");
  const moved = opened.apply(
    opened.tr.setSelection(TextSelection.create(opened.doc, 3))
  );
  const cleared = withEmptyHistory(moved);
  assert.equal(cleared.selection.from, 3);
  assert.equal(cleared.selection.to, 3);
});
