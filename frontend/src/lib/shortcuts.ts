// Display text for the shortcuts Sage binds, in macOS order: ⌃ ⌥ ⇧ ⌘. Add an
// entry here only for a shortcut that works. Tooltips show these as written.
export const shortcuts = {
  bold: "⌘B",
  bulletList: "⇧⌘8",
  closePanel: "⌥⌘B",
  heading1: "⌥⌘1",
  heading2: "⌥⌘2",
  heading3: "⌥⌘3",
  import: "⌘O",
  italic: "⌘I",
  newItem: "⌘N",
  orderedList: "⇧⌘7",
  paragraph: "⌥⌘0",
  quote: "⇧⌘B",
  search: "⌘K",
  settings: "⌘,",
  strikethrough: "⇧⌘S",
  submit: "↩",
  toggleSidebar: "⌘B",
  underline: "⌘U",
} as const;
