import type { Section } from "@/components/journal-context";

interface KeyLike {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** True for the repeats a held key sends. */
  repeat: boolean;
  shiftKey: boolean;
}

export type NewTarget = "chat" | "entry";

/**
 * ⌘N with no other modifier. Ctrl+N does not count, because on a Mac it moves
 * the cursor down a line in a text field. A held key does not count, or it
 * would start one entry after another.
 */
export function isNewKey(event: KeyLike): boolean {
  return (
    event.code === "KeyN" &&
    event.metaKey &&
    !(event.altKey || event.ctrlKey || event.repeat || event.shiftKey)
  );
}

/**
 * What ⌘N starts on each screen: a chat on Chat, an entry on the others.
 * Settings is a form, so it starts nothing.
 */
export function newTarget(section: Section): NewTarget | null {
  if (section === "chat") {
    return "chat";
  }
  if (section === "settings") {
    return null;
  }
  return "entry";
}
