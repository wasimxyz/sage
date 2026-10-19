import { useEffect } from "react";

import { useChat } from "@/components/chat-provider";
import {
  useJournalActions,
  useJournalView,
} from "@/components/journal-context";
import { useMemories } from "@/components/memories-provider";
import { isNewKey, newTarget } from "@/lib/new-shortcut";

// Dialogs, sheets, popovers, menus, and select lists all mark their open popup
// with data-open and a role. Tooltips have neither, so they never block.
const openSurfaceSelector = [
  '[data-slot="dialog-content"][data-open]',
  '[data-open][role="dialog"]',
  '[data-open][role="alertdialog"]',
  '[data-open][role="menu"]',
  '[data-open][role="listbox"]',
].join(",");

/**
 * ⌘N starts a new chat on Chat and a new entry on the other screens. It waits
 * while a dialog, popover, or menu is open, so it does not act on the page
 * behind it.
 */
export function useNewShortcut() {
  const { startDraft } = useJournalActions();
  const { section } = useJournalView();
  const {
    actions: { newChat },
  } = useChat();

  const {
    state: { editor, subjectView },
  } = useMemories();
  const editingMemory = editor !== null || subjectView !== null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isNewKey(event)) {
        return;
      }
      const target = newTarget(section, editingMemory);
      if (target === null || document.querySelector(openSurfaceSelector)) {
        return;
      }
      event.preventDefault();
      if (target === "chat") {
        newChat();
        return;
      }
      startDraft().catch(() => undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingMemory, newChat, section, startDraft]);
}
