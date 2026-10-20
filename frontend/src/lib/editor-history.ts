import { history } from "@tiptap/pm/history";
import { EditorState, type Transaction } from "@tiptap/pm/state";

/**
 * The same transaction, marked so the undo and redo stacks end up empty. The
 * document, selection, and every plugin stay as they are.
 *
 * Opening an entry replaces the whole document, and TipTap has no command to
 * forget what came before. Without this, ⌘Z would bring back the text that
 * was there first, and autosave would save it over the entry on screen.
 *
 * The history plugin takes its next state from a `historyState` meta, which is
 * how its own undo and redo work. A fresh `history()` plugin builds an empty
 * one, and it shares the editor's plugin key. Rebuilding the state with
 * `EditorState.create` would also do it, but it swaps the plugin list, and
 * ProseMirror then destroys and recreates every plugin view, such as the
 * formatting menu.
 */
export function clearHistory(tr: Transaction): Transaction {
  const plugin = history();
  const empty = EditorState.create({ doc: tr.doc, plugins: [plugin] });
  return tr.setMeta(plugin, { historyState: plugin.getState(empty) });
}
