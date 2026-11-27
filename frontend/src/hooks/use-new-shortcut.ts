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
 * ⌘N starts a new chat in the Chat tab, Memories included, and a new entry in
 * the Journal tab. It waits while a dialog, popover, or menu is open, so it
 * does not act on the page behind it.
 */
export function useNewShortcut() {
  const { showChat, startDraft } = useJournalActions();
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
        // From Memories, Chat comes back first.
        showChat()
          .then(newChat)
          .catch(() => undefined);
        return;
      }
      startDraft().catch(() => undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingMemory, newChat, section, showChat, startDraft]);
}
