import type { Editor, JSONContent } from "@tiptap/react";
import type { JournalEntry } from "@/bridge";
import { clearHistory } from "./editor-history.ts";

export const emptyDoc: JSONContent = {
  content: [{ type: "paragraph" }],
  type: "doc",
};

export function plainTextToTiptap(text: string): JSONContent {
  const lines = text.length === 0 ? [""] : text.split("\n");
  return {
    content: lines.map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { content: [{ text: line, type: "text" }], type: "paragraph" }
    ),
    type: "doc",
  };
}

export function parseStoredDoc(entry: JournalEntry): JSONContent {
  if (entry.format === "tiptap") {
    try {
      const parsed: unknown = JSON.parse(entry.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JSONContent;
      }
    } catch {
      // Existing rows may still be plain text even if the format flag is wrong.
    }
  }
  return plainTextToTiptap(entry.body);
}

function setEntryContent(editor: Editor, entry: JournalEntry) {
  if (entry.format === "markdown") {
    if (entry.body.trim().length === 0) {
      editor.commands.setContent(emptyDoc, { emitUpdate: false });
      return;
    }
    try {
      editor.commands.setContent(entry.body, {
        contentType: "markdown",
        emitUpdate: false,
      });
    } catch {
      editor.commands.setContent(plainTextToTiptap(entry.body), {
        emitUpdate: false,
      });
    }
    return;
  }
  editor.commands.setContent(parseStoredDoc(entry), { emitUpdate: false });
}

// Opening an entry is not an edit, so ⌘Z must not undo it.
function forgetHistory(editor: Editor) {
  editor.view.dispatch(clearHistory(editor.state.tr));
}

export function loadEntryContent(editor: Editor, entry: JournalEntry) {
  setEntryContent(editor, entry);
  forgetHistory(editor);
}

export function loadBlankContent(editor: Editor) {
  editor.commands.setContent(emptyDoc, { emitUpdate: false });
  forgetHistory(editor);
}
