// Dialogs, sheets, popovers, menus, and select lists all mark their open popup
// with data-open and a role. Tooltips have neither, so they never block.
const openSurfaceSelector = [
  '[data-slot="dialog-content"][data-open]',
  '[data-open][role="dialog"]',
  '[data-open][role="alertdialog"]',
  '[data-open][role="menu"]',
  '[data-open][role="listbox"]',
].join(",");

/**
 * True while a dialog, popover, or menu is open. A shortcut that would act on
 * the page waits, so it does not change what sits behind the open surface.
 */
export function hasOpenSurface(): boolean {
  return document.querySelector(openSurfaceSelector) !== null;
}
