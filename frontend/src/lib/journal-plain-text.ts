import { generateText } from "@tiptap/core";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

// Same extensions as the journal editor. MarkdownManager.parse plus
// generateText is the headless form of editor.getText() after loading
// markdown with contentType: "markdown".
const extensions = [StarterKit, Markdown];
const markdownManager = new MarkdownManager({ extensions });
const whitespacePattern = /\s+/;

export function stripMarkdown(snippet: string): string {
  if (snippet.length === 0) {
    return "";
  }
  try {
    const doc = markdownManager.parse(snippet);
    return generateText(doc, extensions).trim();
  } catch {
    return snippet;
  }
}

export function collapseWhitespace(text: string): string {
  return text
    .split(whitespacePattern)
    .filter((part) => part.length > 0)
    .join(" ");
}

export function oneLinePlainText(snippet: string): string {
  return collapseWhitespace(stripMarkdown(snippet));
}
