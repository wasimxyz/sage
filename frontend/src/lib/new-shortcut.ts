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
 * What ⌘N starts on each screen: a chat in the Chat tab, which holds Chat and
 * Memories, and an entry in the Journal tab. Memories starts nothing while a
 * memory is open for editing, because leaving would drop what is typed.
 */
export function newTarget(
  section: Section,
  editingMemory: boolean
): NewTarget | null {
  if (section === "journal") {
    return "entry";
  }
  if (section === "memories" && editingMemory) {
    return null;
  }
  return "chat";
}
