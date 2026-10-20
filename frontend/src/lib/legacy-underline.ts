import { Underline } from "@tiptap/extension-underline";

// `++` with no space inside, like the text Sage writes. TipTap's own rule also
// takes `++ and C++`, so typed text such as "C++ and C++" reopened underlined.
const underlineSpan = /^\+\+(?=\S)([\s\S]*?\S)\+\+/;

/**
 * Underline saved as `++text++`, which other Markdown apps show as plain plus
 * signs. Nothing makes it now: no button, ⌘U does nothing, and pasted
 * underline is dropped. The mark stays loaded so text underlined in an older
 * entry still opens underlined and keeps it when the entry saves.
 */
export const LegacyUnderline = Underline.extend({
  // Both spellings: Shift or Caps Lock sends "U". Returning true also stops
  // the browser from underlining the selection on its own.
  addKeyboardShortcuts() {
    return { "Mod-U": () => true, "Mod-u": () => true };
  },
  // Text typed at the end of underlined text is not underlined too. With no
  // button or shortcut, there would be no way to turn it off.
  inclusive: false,
  markdownTokenizer: {
    level: "inline",
    name: "underline",
    start: (src) => src.indexOf("++"),
    tokenize(src, _tokens, lexer) {
      const match = underlineSpan.exec(src);
      if (match === null) {
        return;
      }
      return {
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
        type: "underline",
      };
    },
  },
  // Pasted `<u>` and `text-decoration: underline` do not bring the mark in.
  // Markdown loading does not go through this, so older entries are not hit.
  parseHTML() {
    return [];
  },
});
