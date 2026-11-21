import { useEffect } from "react";

import {
  useDictationActions,
  useDictationAvailable,
} from "@/components/dictation-provider";
import { useJournalView } from "@/components/journal-context";
import { dictationTarget, isDictateKey } from "@/lib/dictation-shortcut";
import { hasOpenSurface } from "@/lib/open-surface";

/**
 * ⌘D starts and stops dictation into the Chat message box or the open entry.
 * It waits while a dialog, popover, or menu is open, so it does not act on the
 * page behind it. It reads the screen on show, so a Chat that is mounted but
 * hidden never takes it.
 */
export function useDictationShortcut() {
  const { detailOpen, section, selection } = useJournalView();
  // Not `useDictation`: its phase changes would redraw the whole app shell.
  const { toggle } = useDictationActions();
  const available = useDictationAvailable();
  const entryOpen = detailOpen && selection !== null;

  useEffect(() => {
    if (!available) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isDictateKey(event)) {
        return;
      }
      const target = dictationTarget(section, entryOpen);
      if (target === null || hasOpenSurface()) {
        return;
      }
      event.preventDefault();
      toggle(target).catch(() => undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available, entryOpen, section, toggle]);
}
