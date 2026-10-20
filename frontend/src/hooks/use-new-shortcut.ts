import { useEffect } from "react";

import { useChat } from "@/components/chat-provider";
import {
  useJournalActions,
  useJournalView,
} from "@/components/journal-context";
import { useMemories } from "@/components/memories-provider";
import { isNewKey, newTarget } from "@/lib/new-shortcut";
import { hasOpenSurface } from "@/lib/open-surface";

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
      if (target === null || hasOpenSurface()) {
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
