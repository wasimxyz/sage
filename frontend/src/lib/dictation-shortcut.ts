import type { Section } from "@/components/journal-context";
import type { DictationOwner } from "./dictation-session.ts";

interface KeyLike {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** True for the repeats a held key sends. */
  repeat: boolean;
  shiftKey: boolean;
}

interface EscapeLike {
  altKey: boolean;
  ctrlKey: boolean;
  /** True when something else already handled the key. */
  defaultPrevented: boolean;
  /** True while an input method is composing, when Esc cancels the composition. */
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * ⌘D with no other modifier. A held key does not count, or it would turn the
 * mic on and off again for as long as it stays down.
 */
export function isDictateKey(event: KeyLike): boolean {
  return (
    event.code === "KeyD" &&
    event.metaKey &&
    !(event.altKey || event.ctrlKey || event.repeat || event.shiftKey)
  );
}

/**
 * True when a key event started in the entry editor. ProseMirror marks every
 * Esc there as handled, so the mark says nothing about a menu or dialog.
 */
export function isInEditor(target: unknown): boolean {
  if (typeof target !== "object" || target === null || !("closest" in target)) {
    return false;
  }
  const { closest } = target;
  return (
    typeof closest === "function" &&
    closest.call(target, ".ProseMirror") !== null
  );
}

/**
 * Esc on its own, when nothing else took it. A menu or dialog that closes on
 * Esc marks the key handled, and an input method uses it to cancel a
 * composition. Neither should also stop dictation. `inEditor` says the key
 * started in the editor, where ProseMirror marks Esc handled whatever happens,
 * so the mark is not read.
 */
export function isStopKey(event: EscapeLike, inEditor = false): boolean {
  return (
    event.key === "Escape" &&
    !(
      event.altKey ||
      event.ctrlKey ||
      (event.defaultPrevented && !inEditor) ||
      event.isComposing ||
      event.metaKey ||
      event.shiftKey
    )
  );
}

/**
 * What ⌘D dictates into on each screen: the message box on Chat, and the open
 * entry on Journal. Home, Memories, and Settings have no place for words.
 */
export function dictationTarget(
  section: Section,
  entryOpen: boolean
): DictationOwner | null {
  if (section === "chat") {
    return "chat";
  }
  if (section === "journal" && entryOpen) {
    return "entry";
  }
  return null;
}
