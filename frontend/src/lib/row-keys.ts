interface KeyLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  /** True for the repeats a held key sends. */
  repeat: boolean;
  shiftKey: boolean;
}

/**
 * ⌘⌫ on a Mac keyboard, with no other modifier held. A held key does not
 * count, or it would delete one row after another.
 */
export function isDeleteKey(event: KeyLike): boolean {
  return (
    event.metaKey &&
    !(event.altKey || event.ctrlKey || event.shiftKey || event.repeat) &&
    (event.key === "Backspace" || event.key === "Delete")
  );
}

/** Return on its own, with no modifier held and not repeating. */
export function isReturnKey(event: KeyLike): boolean {
  return (
    event.key === "Enter" &&
    !(
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      event.shiftKey
    )
  );
}

/** The button of the nearest row in one direction that is not leaving. */
function rowButton(
  item: Element | null,
  direction: "nextElementSibling" | "previousElementSibling"
): HTMLElement | null {
  let row = item?.[direction] ?? null;
  while (row) {
    // A row that is animating out is inert, and its button cannot take focus.
    if (!row.hasAttribute("inert")) {
      const button = row.querySelector<HTMLElement>("button");
      if (button) {
        return button;
      }
    }
    row = row[direction];
  }
  return null;
}

/**
 * Move focus to the row beside this one, so deleting a row does not drop focus
 * to the page. Takes the next row, or the previous one at the end of the list.
 * Rows that are leaving do not count.
 */
export function focusNeighborRow(button: HTMLElement): void {
  const item = button.closest("li");
  const neighbor =
    rowButton(item, "nextElementSibling") ??
    rowButton(item, "previousElementSibling");
  neighbor?.focus();
}
