// Plain-text helpers for dictation. They know nothing about the editor.

// Punctuation that sticks to the word before it, so a phrase that starts with
// it takes no space in front.
const closingPunctuation = /^[.,;:!?)\]}%…”’]/u;
// Text that sticks to the word after it, so a phrase that follows it takes no
// space.
const openingPunctuation = /[([{“‘]$/u;
const startsWithSpace = /^\s/u;
const endsWithSpace = /\s$/u;
const anySpace = /\s+/gu;
const paragraphBreak = /\n[^\S\n]*\n\s*/u;

/**
 * The text to put in for one dictated phrase, with the space it needs. `before`
 * is the text just before the spot, and `after` the text just after it. Pass
 * only the last and first few characters; the rest does not matter.
 *
 * A phrase takes a space in front unless it lands at the start, after a space
 * or an opening bracket, or starts with closing punctuation. A phrase that
 * lands before a word takes a space after it, so it does not run into the word.
 * Returns an empty string for a phrase with no words.
 */
export function joinPhrase(before: string, phrase: string, after = ""): string {
  const words = phrase.replace(anySpace, " ").trim();
  if (words.length === 0) {
    return "";
  }
  const sticks =
    before.length === 0 ||
    endsWithSpace.test(before) ||
    openingPunctuation.test(before) ||
    closingPunctuation.test(words);
  const lead = sticks ? "" : " ";
  const runsOn =
    after.length > 0 &&
    !startsWithSpace.test(after) &&
    !closingPunctuation.test(after);
  return `${lead}${words}${runsOn ? " " : ""}`;
}

/**
 * The paragraphs in a Tidy reply. Blank lines split paragraphs. A single line
 * break inside one is a wrapped line, so it becomes a space. Empty paragraphs
 * are dropped.
 */
export function tidyParagraphs(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split(paragraphBreak)
    .map((paragraph) => paragraph.replace(anySpace, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}
