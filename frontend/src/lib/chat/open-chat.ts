import type { ChatLoadPromise } from "@/lib/chat/load-conversation";

/**
 * Whether opening chat `id` keeps the pane the screen already has. A chat that
 * is open keeps its pane, so a reply that is still coming in is not cut off.
 * A chat whose read failed does not, because opening it again reads it again.
 */
export function keepsOpenPane(
  selection:
    | { kind: "new"; load: ChatLoadPromise }
    | { id: number; kind: "saved"; load: ChatLoadPromise },
  id: number
): boolean {
  if (selection.kind !== "saved" || selection.id !== id) {
    return false;
  }
  const { load } = selection;
  return !(load.status === "fulfilled" && load.value.kind === "failed");
}
