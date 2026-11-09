import assert from "node:assert/strict";
import test from "node:test";
import { Markdown } from "@tiptap/markdown";
import { undoDepth } from "@tiptap/pm/history";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import {
  beginTidy,
  cancelTidy,
  Dictation,
  type DictationView,
  dictationState,
  finishTidy,
  isPlainRange,
  keepTidy,
  pushEditorDictation,
  readDictationView,
  resetEditorDictation,
  settleEditorDictation,
  startEditorDictation,
  undoTidy,
} from "./dictation-plugin.ts";

function docOf(...paragraphs: string[]): JSONContent {
  return {
    content: paragraphs.map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { content: [{ text: line, type: "text" }], type: "paragraph" }
    ),
    type: "doc",
  };
}

// An editor with no view leaves its plugins out of the state. The app's view
// adds them, so add them here too.
function makeEditor(...paragraphs: string[]) {
  const editor = new Editor({
    content: docOf(...(paragraphs.length === 0 ? [""] : paragraphs)),
    extensions: [StarterKit, Markdown, Dictation],
  });
  editor.view.updateState(
    editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
  );
  return editor;
}

interface TestView extends DictationView {
  composing: boolean;
}

// The headless editor's view is a new object on each read, so hand the plugin
// one that stays put and whose `composing` a test can change.
function viewOf(editor: Editor): TestView {
  return {
    composing: false,
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
    get state() {
      return editor.state;
    },
  };
}

function typeAt(editor: Editor, chars: string, pos: number) {
  editor.view.dispatch(editor.state.tr.insertText(chars, pos));
}

function moveCursor(editor: Editor, pos: number) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
  );
}

function cursorToEnd(editor: Editor) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc))
  );
}

function text(editor: Editor): string {
  return editor.getText();
}

function begin(editor: Editor, atEnd = false) {
  const view = viewOf(editor);
  startEditorDictation(view, { atEnd });
  return view;
}

test("the plugin starts out idle", () => {
  const editor = makeEditor("Hello");
  const ps = dictationState(editor.state);
  assert.equal(ps.active, false);
  assert.equal(ps.range, null);
  assert.equal(ps.tidy, null);
});

test("grey words are never part of the document or its Markdown", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "grey words");
  assert.equal(dictationState(editor.state).tail, "grey words");
  assert.equal(text(editor), "Hello");
  assert.equal(editor.getMarkdown(), "Hello");
  assert.deepEqual(editor.getJSON(), docOf("Hello"));
});

test("a grey tail does not fire an update, so it does not save", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  let updates = 0;
  editor.on("update", () => {
    updates += 1;
  });
  const view = begin(editor);
  pushEditorDictation(view, "", "grey");
  pushEditorDictation(view, "", "grey words");
  settleEditorDictation(viewOf(editor));
  assert.equal(updates, 1);
});

test("settled words go in as text at the cursor and fire an update", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  let updates = 0;
  editor.on("update", () => {
    updates += 1;
  });
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  assert.equal(text(editor), "Hello there");
  assert.equal(updates, 1);
  pushEditorDictation(view, "and more", "");
  assert.equal(text(editor), "Hello there and more");
  assert.equal(editor.getMarkdown(), "Hello there and more");
  assert.equal(updates, 2);
});

test("settled words are plain text, never HTML or Markdown", () => {
  const editor = makeEditor("");
  const view = begin(editor);
  pushEditorDictation(view, "<b>bold</b> *star* # not a heading", "");
  const [paragraph] = editor.getJSON().content;
  assert.deepEqual(paragraph.content, [
    { text: "<b>bold</b> *star* # not a heading", type: "text" },
  ]);
  assert.equal(JSON.stringify(editor.getJSON()).includes('"marks"'), false);
});

test("settled words take no marks, even inside bold text", () => {
  const editor = new Editor({
    content: {
      content: [
        {
          content: [{ marks: [{ type: "bold" }], text: "Bold", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    },
    extensions: [StarterKit, Markdown, Dictation],
  });
  editor.view.updateState(
    editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
  );
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "plain", "");
  const [paragraph] = editor.getJSON().content;
  assert.equal(paragraph.content?.at(-1)?.marks, undefined);
  assert.equal(paragraph.content?.at(-1)?.text, " plain");
});

test("an empty settled message changes only the tail", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "   ", "next");
  assert.equal(text(editor), "Hello");
  assert.equal(dictationState(editor.state).tail, "next");
  pushEditorDictation(view, "", "");
  assert.equal(dictationState(editor.state).tail, "");
});

test("words arriving when no session is on go nowhere", () => {
  const editor = makeEditor("Hello");
  pushEditorDictation(viewOf(editor), "lost", "grey");
  assert.equal(text(editor), "Hello");
  assert.equal(dictationState(editor.state).tail, "");
});

test("spacing follows the text before and after the spot", () => {
  const editor = makeEditor("one  three");
  moveCursor(editor, 5);
  const view = begin(editor);
  pushEditorDictation(view, "two", "");
  assert.equal(text(editor), "one two three");
});

test("typing before the anchor moves it along", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  typeAt(editor, "XX", 1);
  assert.equal(dictationState(editor.state).anchor, 8);
  pushEditorDictation(view, "world", "");
  assert.equal(text(editor), "XXHello world");
});

test("typing at the anchor pushes it past what was typed", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  typeAt(editor, "!", 6);
  assert.equal(dictationState(editor.state).anchor, 7);
  pushEditorDictation(view, "world", "");
  assert.equal(text(editor), "Hello! world");
});

test("typing after the anchor leaves it where it was", () => {
  const editor = makeEditor("Hello world");
  moveCursor(editor, 6);
  const view = begin(editor);
  typeAt(editor, "X", 12);
  assert.equal(dictationState(editor.state).anchor, 6);
  pushEditorDictation(view, "big", "");
  assert.equal(text(editor), "Hello big worldX");
});

test("typing while words are grey keeps them where they were", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "grey");
  typeAt(editor, "<<", 1);
  assert.equal(dictationState(editor.state).anchor, 8);
  assert.equal(dictationState(editor.state).tail, "grey");
  pushEditorDictation(view, "settled", "");
  assert.equal(text(editor), "<<Hello settled");
});

test("a cursor move while words are grey waits for the phrase to settle", () => {
  const editor = makeEditor("AAA BBB");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "grey");
  moveCursor(editor, 1);
  const moved = dictationState(editor.state);
  assert.equal(moved.pending, 1);
  assert.equal(moved.anchor, 8);
  // The phrase in progress settles where its grey words were.
  pushEditorDictation(view, "first", "next");
  assert.equal(text(editor), "AAA BBB first");
  const after = dictationState(editor.state);
  assert.equal(after.anchor, 1);
  assert.equal(after.pending, null);
  assert.equal(after.tail, "next");
  // The next phrase starts at the cursor.
  pushEditorDictation(view, "second", "");
  assert.equal(text(editor), "second AAA BBB first");
});

test("a cursor move while nothing is grey takes effect at once", () => {
  const editor = makeEditor("AAA BBB");
  cursorToEnd(editor);
  const view = begin(editor);
  moveCursor(editor, 5);
  const moved = dictationState(editor.state);
  assert.equal(moved.anchor, 5);
  assert.equal(moved.pending, null);
  pushEditorDictation(view, "and", "");
  assert.equal(text(editor), "AAA and BBB");
});

test("the cursor ends up after the words it was at", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  assert.equal(editor.state.selection.from, editor.state.doc.content.size - 1);
  pushEditorDictation(view, "again", "");
  assert.equal(text(editor), "Hello there again");
});

test("typing moves a pending cursor along too", () => {
  const editor = makeEditor("AAA BBB");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "grey");
  moveCursor(editor, 5);
  typeAt(editor, "ZZ", 1);
  assert.equal(dictationState(editor.state).pending, 7);
  pushEditorDictation(view, "x", "");
  assert.equal(dictationState(editor.state).anchor, 7);
});

test("a move to the same spot changes nothing", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "grey");
  moveCursor(editor, 6);
  pushEditorDictation(view, "there", "");
  pushEditorDictation(view, "again", "");
  assert.equal(text(editor), "Hello there again");
});

test("a grey tail that ends with nothing settled lets the cursor move on", () => {
  const editor = makeEditor("AAA BBB");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "", "um");
  moveCursor(editor, 1);
  pushEditorDictation(view, "", "");
  const ps = dictationState(editor.state);
  assert.equal(ps.anchor, 1);
  assert.equal(ps.pending, null);
});

test("with the title focused, words go to the end of the body in a new paragraph", () => {
  const editor = makeEditor("First paragraph.");
  const view = begin(editor, true);
  pushEditorDictation(view, "", "grey");
  assert.equal(text(editor), "First paragraph.");
  pushEditorDictation(view, "Second one", "");
  assert.equal(text(editor), "First paragraph.\n\nSecond one");
  pushEditorDictation(view, "and more", "");
  assert.equal(text(editor), "First paragraph.\n\nSecond one and more");
  assert.equal(editor.state.doc.childCount, 2);
});

test("at the end of the body, an empty last paragraph is used", () => {
  const editor = makeEditor("First paragraph.", "");
  const view = begin(editor, true);
  pushEditorDictation(view, "Second", "");
  assert.equal(editor.state.doc.childCount, 2);
  assert.equal(text(editor), "First paragraph.\n\nSecond");
});

test("at the end of the body, a last heading gets a new paragraph after it", () => {
  const editor = new Editor({
    content: {
      content: [
        {
          attrs: { level: 2 },
          content: [{ text: "Heading", type: "text" }],
          type: "heading",
        },
      ],
      type: "doc",
    },
    extensions: [StarterKit, Markdown, Dictation],
  });
  editor.view.updateState(
    editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
  );
  const view = begin(editor, true);
  pushEditorDictation(view, "Under it", "");
  assert.equal(editor.getMarkdown(), "## Heading\n\nUnder it");
});

test("a session that hears nothing leaves the body as it was", () => {
  const editor = makeEditor("First paragraph.");
  let updates = 0;
  editor.on("update", () => {
    updates += 1;
  });
  const view = begin(editor, true);
  pushEditorDictation(view, "", "");
  settleEditorDictation(view);
  assert.equal(editor.state.doc.childCount, 1);
  assert.equal(updates, 0);
  assert.equal(dictationState(editor.state).active, false);
});

test("the first words at the end of the body are one undo step", () => {
  const editor = makeEditor("First paragraph.");
  const view = begin(editor, true);
  pushEditorDictation(view, "Second", "");
  assert.equal(undoDepth(editor.state), 1);
  assert.equal(editor.commands.undo(), true);
  assert.equal(text(editor), "First paragraph.");
});

test("settling puts the grey words in as final text and ends the session", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "my grey friend");
  settleEditorDictation(view);
  assert.equal(text(editor), "Hello there my grey friend");
  const ps = dictationState(editor.state);
  assert.equal(ps.active, false);
  assert.equal(ps.tail, "");
  pushEditorDictation(view, "late", "");
  assert.equal(text(editor), "Hello there my grey friend");
});

test("settling with nothing grey adds nothing", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  settleEditorDictation(view);
  assert.equal(text(editor), "Hello there");
  assert.equal(dictationState(editor.state).active, false);
});

test("settled words wait while an input method is composing", async () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  view.composing = true;
  pushEditorDictation(view, "there", "grey");
  assert.equal(text(editor), "Hello");
  assert.deepEqual(dictationState(editor.state).waiting, ["there"]);
  assert.equal(dictationState(editor.state).tail, "grey");
  pushEditorDictation(view, "again", "grey two");
  assert.deepEqual(dictationState(editor.state).waiting, ["there", "again"]);
  view.composing = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(text(editor), "Hello there again");
  assert.deepEqual(dictationState(editor.state).waiting, []);
  assert.equal(dictationState(editor.state).tail, "grey two");
});

test("settled words go in once composing ends, with the next message", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  view.composing = true;
  pushEditorDictation(view, "there", "");
  view.composing = false;
  pushEditorDictation(view, "again", "");
  assert.equal(text(editor), "Hello there again");
});

test("settling does not wait for an input method", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  view.composing = true;
  pushEditorDictation(view, "there", "grey");
  settleEditorDictation(view);
  assert.equal(text(editor), "Hello there grey");
});

test("resetting forgets the session, the stretch, and the Tidy", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "grey");
  resetEditorDictation(view);
  const ps = dictationState(editor.state);
  assert.equal(ps.active, false);
  assert.equal(ps.range, null);
  assert.equal(ps.tail, "");
});

// --- the dictated stretch ---

function stretch(editor: Editor): string | null {
  const { range } = dictationState(editor.state);
  return range === null
    ? null
    : editor.state.doc.textBetween(range.from, range.to, "\n\n");
}

test("the dictated stretch covers the words, without the space before them", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  assert.equal(stretch(editor), "there");
  pushEditorDictation(view, "my friend", "");
  assert.equal(stretch(editor), "there my friend");
});

test("the stretch outlives the session, for Tidy", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "grey");
  settleEditorDictation(view);
  assert.equal(stretch(editor), "there grey");
  assert.equal(readDictationView(editor.state).canTidyDictated, true);
});

test("typing clears the stretch", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  settleEditorDictation(view);
  typeAt(editor, "!", 1);
  assert.equal(dictationState(editor.state).range, null);
  assert.equal(readDictationView(editor.state).canTidyDictated, false);
});

test("undo clears the stretch", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  pushEditorDictation(view, "again", "");
  settleEditorDictation(view);
  assert.notEqual(dictationState(editor.state).range, null);
  assert.equal(editor.commands.undo(), true);
  assert.equal(dictationState(editor.state).range, null);
});

test("moving the cursor keeps the stretch", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  settleEditorDictation(view);
  moveCursor(editor, 1);
  assert.equal(stretch(editor), "there");
});

test("words that land somewhere else start a new stretch", () => {
  const editor = makeEditor("AAA BBB");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "one", "");
  moveCursor(editor, 1);
  pushEditorDictation(view, "two", "");
  assert.equal(stretch(editor), "two");
});

test("starting again forgets the last stretch", () => {
  const editor = makeEditor("Hello");
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "there", "");
  settleEditorDictation(view);
  startEditorDictation(view, { atEnd: false });
  assert.equal(dictationState(editor.state).range, null);
});

// --- Tidy ---

function dictated(...paragraphs: string[]) {
  const editor = makeEditor(...paragraphs);
  cursorToEnd(editor);
  const view = begin(editor);
  pushEditorDictation(view, "um so I went to the shop and I got milk", "");
  settleEditorDictation(view);
  return { editor, view };
}

test("Tidy sends the dictated words and nothing else", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  assert.equal(request.text, "um so I went to the shop and I got milk");
  assert.equal(dictationState(editor.state).tidy?.kind, "working");
  assert.equal(readDictationView(editor.state).tidy, "working");
});

test("Tidy swaps the words for the reply as paragraphs, in one undo step", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  const depth = undoDepth(editor.state);
  const outcome = finishTidy(
    view,
    request.id,
    "I went to the shop.\n\nI got milk."
  );
  assert.equal(outcome, "applied");
  assert.equal(
    text(editor),
    "Earlier text. I went to the shop.\n\nI got milk."
  );
  assert.equal(undoDepth(editor.state), depth + 1);
  assert.equal(dictationState(editor.state).tidy?.kind, "review");
  assert.equal(dictationState(editor.state).range, null);
  // One ⌘Z puts it all back.
  assert.equal(editor.commands.undo(), true);
  assert.equal(
    text(editor),
    "Earlier text. um so I went to the shop and I got milk"
  );
});

test("Tidy leaves the next change as its own undo step", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.");
  typeAt(editor, "!", 1);
  assert.equal(editor.commands.undo(), true);
  assert.equal(text(editor), "Earlier text. I went to the shop.");
});

test("Undo puts back the original words", () => {
  const { editor, view } = dictated("Earlier text.");
  const before = text(editor);
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.\n\nI got milk.");
  assert.equal(undoTidy(view), true);
  assert.equal(text(editor), before);
  assert.equal(editor.state.doc.childCount, 1);
  assert.equal(dictationState(editor.state).tidy, null);
});

test("Keep clears the review and leaves the text", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.");
  keepTidy(view);
  assert.equal(dictationState(editor.state).tidy, null);
  assert.equal(text(editor), "Earlier text. I went to the shop.");
  assert.equal(undoTidy(view), false);
});

test("typing counts as Keep", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.");
  typeAt(editor, "!", 1);
  assert.equal(dictationState(editor.state).tidy, null);
  assert.equal(readDictationView(editor.state).tidy, "idle");
});

test("starting to dictate again counts as Keep", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.");
  startEditorDictation(view, { atEnd: false });
  assert.equal(dictationState(editor.state).tidy, null);
});

test("Tidy drops its reply when the words changed meanwhile", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  typeAt(editor, "XX", range.from + 4);
  const outcome = finishTidy(view, request.id, "I went to the shop.");
  assert.equal(outcome, "edited");
  assert.equal(text(editor).includes("XX"), true);
  assert.equal(text(editor).includes("I went to the shop."), false);
  assert.equal(dictationState(editor.state).tidy, null);
});

test("Tidy drops its reply when words inside were deleted", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  editor.view.dispatch(editor.state.tr.delete(range.from + 2, range.from + 6));
  assert.equal(finishTidy(view, request.id, "Reply."), "edited");
  assert.equal(text(editor).includes("Reply."), false);
});

test("Tidy still runs when the person typed before or after the words", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  typeAt(editor, ">>", 1);
  typeAt(editor, "<<", editor.state.doc.content.size - 1);
  const outcome = finishTidy(view, request.id, "I went to the shop.");
  assert.equal(outcome, "applied");
  assert.equal(text(editor), ">>Earlier text. I went to the shop.<<");
});

test("a Tidy that is no longer open is ignored", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  resetEditorDictation(view);
  const before = text(editor);
  assert.equal(finishTidy(view, request.id, "Reply."), "gone");
  assert.equal(text(editor), before);
});

test("a reply with no words changes nothing", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  const before = text(editor);
  assert.equal(finishTidy(view, request.id, "  \n\n "), "unusable");
  assert.equal(text(editor), before);
  assert.equal(dictationState(editor.state).tidy, null);
});

test("a failed Tidy leaves the words, and the stretch to try again", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  cancelTidy(view, request.id);
  assert.equal(dictationState(editor.state).tidy, null);
  assert.notEqual(dictationState(editor.state).range, null);
  assert.equal(readDictationView(editor.state).canTidyDictated, true);
});

test("Tidy does not start while dictating or while another Tidy is open", () => {
  const editor = makeEditor("Hello there");
  cursorToEnd(editor);
  const view = begin(editor);
  assert.equal(beginTidy(view, { from: 1, to: 6 }), null);
  settleEditorDictation(view);
  const first = beginTidy(view, { from: 1, to: 6 });
  assert.ok(first);
  assert.equal(beginTidy(view, { from: 1, to: 6 }), null);
});

test("Tidy works on a selection inside a paragraph, and joins the text around it", () => {
  const editor = makeEditor("Intro. some rambling words. Outro.");
  const view = viewOf(editor);
  const start = editor.state.doc.textContent.indexOf("some") + 1;
  const end = start + "some rambling words.".length;
  const request = beginTidy(view, { from: start, to: end });
  assert.ok(request);
  assert.equal(request.text, "some rambling words.");
  assert.equal(finishTidy(view, request.id, "A few words."), "applied");
  assert.equal(text(editor), "Intro. A few words. Outro.");
  assert.equal(editor.state.doc.childCount, 1);
  assert.equal(undoTidy(view), true);
  assert.equal(text(editor), "Intro. some rambling words. Outro.");
  assert.equal(editor.state.doc.childCount, 1);
});

test("Tidy splits the paragraph around a selection when the reply has several", () => {
  const editor = makeEditor("Intro. some rambling words. Outro.");
  const view = viewOf(editor);
  const start = editor.state.doc.textContent.indexOf("some") + 1;
  const end = start + "some rambling words.".length;
  const request = beginTidy(view, { from: start, to: end });
  assert.ok(request);
  assert.equal(finishTidy(view, request.id, "One.\n\nTwo."), "applied");
  assert.equal(text(editor), "Intro. One.\n\nTwo. Outro.");
  assert.equal(editor.state.doc.childCount, 2);
  assert.equal(undoTidy(view), true);
  assert.equal(text(editor), "Intro. some rambling words. Outro.");
  assert.equal(editor.state.doc.childCount, 1);
});

test("Tidy works across paragraphs and sends a blank line between them", () => {
  const editor = makeEditor("First rambling one.", "Second rambling one.");
  const view = viewOf(editor);
  const request = beginTidy(view, {
    from: 1,
    to: editor.state.doc.content.size - 1,
  });
  assert.ok(request);
  assert.equal(request.text, "First rambling one.\n\nSecond rambling one.");
  assert.equal(finishTidy(view, request.id, "Both, tidied."), "applied");
  assert.equal(text(editor), "Both, tidied.");
  assert.equal(editor.state.doc.childCount, 1);
  assert.equal(undoTidy(view), true);
  assert.equal(text(editor), "First rambling one.\n\nSecond rambling one.");
});

test("Tidy keeps the Markdown clean", () => {
  const { editor, view } = dictated("Earlier text.");
  const { range } = dictationState(editor.state);
  assert.ok(range);
  const request = beginTidy(view, range);
  assert.ok(request);
  finishTidy(view, request.id, "I went to the shop.\n\nI got milk.");
  assert.equal(
    editor.getMarkdown(),
    "Earlier text. I went to the shop.\n\nI got milk."
  );
});

test("only plain paragraphs can be tidied", () => {
  const plain = makeEditor("Just words.", "More words.");
  const { doc } = plain.state;
  assert.equal(isPlainRange(doc, 1, doc.content.size - 1), true);
  assert.equal(isPlainRange(doc, 3, 3), false);
  assert.equal(isPlainRange(doc, 0, doc.content.size + 5), false);

  const rich = new Editor({
    content:
      "A plain line.\n\nSome **bold** text.\n\n- a list item\n\n## A heading\n\n> a quote",
    contentType: "markdown",
    extensions: [StarterKit, Markdown, Dictation],
  });
  const richDoc = rich.state.doc;
  const lineAt = (needle: string) => {
    let found = -1;
    richDoc.descendants((node, pos) => {
      if (node.isText && node.text?.includes(needle)) {
        found = pos;
      }
    });
    return found;
  };
  const plainStart = lineAt("A plain line.");
  assert.equal(isPlainRange(richDoc, plainStart, plainStart + 13), true);
  const boldStart = lineAt("Some ");
  assert.equal(isPlainRange(richDoc, boldStart, boldStart + 14), false);
  const listStart = lineAt("a list item");
  assert.equal(isPlainRange(richDoc, listStart, listStart + 11), false);
  const headingStart = lineAt("A heading");
  assert.equal(isPlainRange(richDoc, headingStart, headingStart + 9), false);
  const quoteStart = lineAt("a quote");
  assert.equal(isPlainRange(richDoc, quoteStart, quoteStart + 7), false);
  assert.equal(
    isPlainRange(richDoc, plainStart, richDoc.content.size - 1),
    false
  );
});

test("Tidy refuses a range that is not plain paragraphs", () => {
  const editor = new Editor({
    content: "Some **bold** text.",
    contentType: "markdown",
    extensions: [StarterKit, Markdown, Dictation],
  });
  editor.view.updateState(
    editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
  );
  const view = viewOf(editor);
  assert.equal(
    beginTidy(view, { from: 1, to: editor.state.doc.content.size - 1 }),
    null
  );
});

test("the selection can be tidied only when it is plain", () => {
  const editor = makeEditor("Just plain words here.");
  assert.equal(readDictationView(editor.state).canTidySelection, false);
  assert.equal(readDictationView(editor.state).selectionNeedsPlain, false);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 9))
  );
  assert.equal(readDictationView(editor.state).canTidySelection, true);

  const rich = new Editor({
    content: "Some **bold** text.",
    contentType: "markdown",
    extensions: [StarterKit, Markdown, Dictation],
  });
  rich.view.updateState(
    rich.state.reconfigure({ plugins: rich.extensionManager.plugins })
  );
  rich.view.dispatch(
    rich.state.tr.setSelection(TextSelection.create(rich.state.doc, 1, 12))
  );
  const view = readDictationView(rich.state);
  assert.equal(view.canTidySelection, false);
  assert.equal(view.selectionNeedsPlain, true);
});

test("the selection cannot be tidied while dictating or tidying", () => {
  const editor = makeEditor("Just plain words here.");
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 9))
  );
  const view = begin(editor);
  assert.equal(readDictationView(editor.state).canTidySelection, false);
  settleEditorDictation(view);
  const request = beginTidy(view, { from: 1, to: 9 });
  assert.ok(request);
  assert.equal(readDictationView(editor.state).canTidySelection, false);
});
