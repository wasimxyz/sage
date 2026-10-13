interface KeyLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

/** ⌘⌫ on a Mac keyboard, with no other modifier held. */
export function isDeleteKey(event: KeyLike): boolean {
  return (
    event.metaKey &&
    !(event.altKey || event.ctrlKey || event.shiftKey) &&
    (event.key === "Backspace" || event.key === "Delete")
  );
}

/** Return on its own, with no modifier held. */
export function isReturnKey(event: KeyLike): boolean {
  return (
    event.key === "Enter" &&
    !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
  );
}

/**
 * Move focus to the row beside this one, so deleting a row does not drop focus
 * to the page. Takes the next row, or the previous one at the end of the list.
 */
export function focusNeighborRow(button: HTMLElement): void {
  const item = button.closest("li");
  const neighbor = item?.nextElementSibling ?? item?.previousElementSibling;
  neighbor?.querySelector<HTMLElement>("button")?.focus();
}
