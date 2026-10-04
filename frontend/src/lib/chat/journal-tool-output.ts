import { Markdown, MarkdownManager } from "@tiptap/markdown";
import type { JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { collapseWhitespace, oneLinePlainText } from "../journal-plain-text.ts";

/** How much of an entry the Chat card shows before the ellipsis. */
export const journalPreviewChars = 300;

const extensions = [StarterKit, Markdown];
const markdownManager = new MarkdownManager({ extensions });

export interface JournalToolSearchHit {
  date: string;
  id: number;
  snippet: string;
  title: string;
}

export interface JournalToolEntry {
  body: string;
  bodyFormat: "plain" | "markdown" | "tiptap";
  date: string;
  id: number;
  title: string;
}

export type JournalBodyContent =
  | { kind: "markdown"; text: string }
  | { kind: "plain"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function journalSearchQuery(input: unknown): string | null {
  if (!isRecord(input) || typeof input.query !== "string") {
    return null;
  }
  return input.query;
}

export function journalSearchHits(
  output: unknown
): JournalToolSearchHit[] | null {
  if (!Array.isArray(output)) {
    return null;
  }

  const hits: JournalToolSearchHit[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      return null;
    }
    if (
      !isPositiveInteger(item.id) ||
      typeof item.title !== "string" ||
      typeof item.date !== "string" ||
      typeof item.snippet !== "string"
    ) {
      return null;
    }
    hits.push({
      date: item.date,
      id: item.id,
      snippet: item.snippet,
      title: item.title,
    });
  }
  return hits;
}

export function journalEntryOutput(output: unknown): JournalToolEntry | null {
  if (!isRecord(output)) {
    return null;
  }
  if (
    !isPositiveInteger(output.id) ||
    typeof output.title !== "string" ||
    typeof output.date !== "string" ||
    typeof output.body !== "string" ||
    (output.bodyFormat !== "plain" &&
      output.bodyFormat !== "markdown" &&
      output.bodyFormat !== "tiptap")
  ) {
    return null;
  }
  return {
    body: output.body,
    bodyFormat: output.bodyFormat,
    date: output.date,
    id: output.id,
    title: output.title,
  };
}

/**
 * The start of an entry as one line of plain text, cut at `limit` characters
 * with an ellipsis. Empty when the entry has no text.
 */
export function journalEntryPreview(
  content: JournalBodyContent,
  limit = journalPreviewChars
): string {
  const text =
    content.kind === "markdown"
      ? oneLinePlainText(content.text)
      : collapseWhitespace(content.text);
  if (text.length <= limit) {
    return text;
  }
  let end = limit;
  // Keep a surrogate pair whole, so an emoji is not cut in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd8_00 && last <= 0xdb_ff) {
    end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}

export function journalBodyContent(
  entry: JournalToolEntry
): JournalBodyContent | null {
  if (entry.bodyFormat === "plain") {
    return { kind: "plain", text: entry.body };
  }
  if (entry.bodyFormat === "markdown") {
    return { kind: "markdown", text: entry.body };
  }
  if (entry.body.trim().length === 0) {
    return { kind: "markdown", text: "" };
  }

  try {
    const parsed: unknown = JSON.parse(entry.body);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return {
      kind: "markdown",
      text: markdownManager.serialize(parsed as JSONContent),
    };
  } catch {
    return null;
  }
}
