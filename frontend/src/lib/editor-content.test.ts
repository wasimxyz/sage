import assert from "node:assert/strict";
import test from "node:test";
import { Markdown } from "@tiptap/markdown";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import {
  emptyDoc,
  loadBlankContent,
  loadEntryContent,
  parseStoredDoc,
  plainTextToTiptap,
} from "./editor-content.ts";

interface Entry {
  body: string;
  date: string;
  format: "markdown" | "plain" | "tiptap";
  id: number;
  title: string;
  updatedAt: string;
  wordCount: number;
}

function entry(
  id: number,
  body: string,
  format: Entry["format"] = "markdown"
): Entry {
  return {
    body,
    date: "2026-10-19",
    format,
    id,
    title: `Entry ${id}`,
    updatedAt: "",
    wordCount: 0,
  };
}

// An editor with no view leaves its plugins out of the state, and the undo
// history is one of them. The app's view adds them, so add them here too.
// Without that, every history check below would pass on nothing.
function makeEditor() {
  const editor = new Editor({
    content: emptyDoc,
    extensions: [StarterKit, Markdown],
  });
  editor.view.updateState(
    editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
  );
  return editor;
}

function type(editor: Editor, text: string) {
  const { state } = editor;
  editor.view.dispatch(state.tr.insertText(text, state.doc.content.size - 1));
}

test("the headless editor records typing in its undo history", () => {
  const editor = makeEditor();
  type(editor, "x");
  assert.equal(undoDepth(editor.state), 1);
});

test("opening an entry leaves nothing to undo", () => {
  const editor = makeEditor();
  loadEntryContent(editor, entry(1, "Alpha"));
  assert.equal(editor.getText(), "Alpha");
  assert.equal(undoDepth(editor.state), 0);
  assert.equal(editor.commands.undo(), false);
  assert.equal(editor.getText(), "Alpha");
});

test("opening a second entry cannot bring back the first", () => {
  const editor = makeEditor();
  loadEntryContent(editor, entry(1, "Alpha"));
  type(editor, " edited");
  assert.equal(undoDepth(editor.state), 1);
  loadEntryContent(editor, entry(2, "Bravo"));
  assert.equal(undoDepth(editor.state), 0);
  assert.equal(redoDepth(editor.state), 0);
  assert.equal(editor.commands.undo(), false);
  assert.equal(editor.getText(), "Bravo");
});

test("a new entry cannot bring back the last entry", () => {
  const editor = makeEditor();
  loadEntryContent(editor, entry(1, "Alpha"));
  loadBlankContent(editor);
  assert.equal(editor.getText(), "");
  assert.equal(undoDepth(editor.state), 0);
  assert.equal(editor.commands.undo(), false);
  assert.equal(editor.getText(), "");
});

test("typing after opening an entry can be undone", () => {
  const editor = makeEditor();
  loadEntryContent(editor, entry(1, "Alpha"));
  type(editor, "!");
  assert.equal(editor.getText(), "Alpha!");
  assert.equal(editor.commands.undo(), true);
  assert.equal(editor.getText(), "Alpha");
  assert.equal(editor.commands.undo(), false);
});

test("opening an entry does not count as an edit", () => {
  const editor = makeEditor();
  let updates = 0;
  editor.on("update", () => {
    updates += 1;
  });
  loadEntryContent(editor, entry(1, "Alpha"));
  loadBlankContent(editor);
  loadEntryContent(editor, entry(2, "Bravo"));
  assert.equal(updates, 0);
  type(editor, "!");
  assert.equal(updates, 1);
});

test("opening an entry keeps the editor's plugins", () => {
  const editor = makeEditor();
  const before = editor.state.plugins;
  loadEntryContent(editor, entry(1, "Alpha"));
  loadBlankContent(editor);
  assert.equal(editor.state.plugins, before);
});

test("each stored format opens as its text", () => {
  const editor = makeEditor();
  loadEntryContent(editor, entry(1, "# Title\n\nBody", "markdown"));
  assert.equal(editor.getText(), "Title\n\nBody");
  loadEntryContent(editor, entry(2, "One\nTwo", "plain"));
  assert.equal(editor.getText(), "One\n\nTwo");
  const stored = JSON.stringify(plainTextToTiptap("Stored"));
  loadEntryContent(editor, entry(3, stored, "tiptap"));
  assert.equal(editor.getText(), "Stored");
  loadEntryContent(editor, entry(4, "  \n", "markdown"));
  assert.equal(editor.getText(), "");
});

test("a tiptap entry with a broken body opens as plain text", () => {
  const doc = parseStoredDoc(entry(1, "not json", "tiptap"));
  assert.deepEqual(doc, plainTextToTiptap("not json"));
});
