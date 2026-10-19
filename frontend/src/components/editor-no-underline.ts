import { Extension } from "@tiptap/react";

/**
 * ⌘U does nothing. The Underline extension stays loaded, so text underlined in
 * an older entry still opens underlined and keeps it when the entry saves.
 * With no button and no shortcut, new text cannot get it. Other Markdown apps
 * show its `++text++` form as plain plus signs.
 */
export const NoUnderlineShortcut = Extension.create({
  addKeyboardShortcuts() {
    return { "Mod-u": () => true };
  },
  name: "noUnderlineShortcut",
  // Ahead of the Underline extension's own ⌘U.
  priority: 1000,
});
