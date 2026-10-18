import { useEffect } from "react";

import { useChat } from "@/components/chat-provider";
import { useJournal } from "@/components/journal-context";
import { isNewKey, newTarget } from "@/lib/new-shortcut";

const openDialogSelector = '[data-slot="dialog-content"][data-open]';

/**
 * ⌘N starts a new chat on Chat and a new entry on the other screens. It waits
 * while a dialog is open, so it does not act on the page behind it.
 */
export function useNewShortcut() {
  const {
    actions: { startDraft },
    state: { section },
  } = useJournal();
  const {
    actions: { newChat },
  } = useChat();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isNewKey(event)) {
        return;
      }
      const target = newTarget(section);
      if (target === null || document.querySelector(openDialogSelector)) {
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
  }, [newChat, section, startDraft]);
}
