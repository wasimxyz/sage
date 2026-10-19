import { EditorState } from "@tiptap/pm/state";

/**
 * The same document, selection, and plugins, with nothing left to undo.
 * Opening an entry replaces the whole document, and TipTap has no command to
 * forget what came before. Without this, ⌘Z would bring back the text that
 * was there first, and autosave would save it over the entry on screen.
 */
export function withEmptyHistory(state: EditorState): EditorState {
  return EditorState.create({
    doc: state.doc,
    plugins: state.plugins,
    schema: state.schema,
    selection: state.selection,
  });
}
