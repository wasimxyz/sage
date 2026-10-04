import { parseDate } from "chrono-node";

import { countWords } from "@/bridge";

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const frontmatterKeyPattern = /^(\w[\w-]*)\s*:\s*(.*)$/;
const headingPattern = /^#\s+(.+)$/;
const dateLinePattern = /^date:\s*(.+)$/i;
const bomPattern = /^\uFEFF/;
const lineBreakPattern = /\r?\n/;
const leadingScanLines = 20;

export interface ParsedImport {
  body: string;
  date: string;
  title: string;
  warnings: string[];
  wordCount: number;
}

export function parseMarkdownEntry(input: {
  content: string;
  created: string;
  fileName: string;
}): ParsedImport {
  const warnings: string[] = [];
  const stripped = applyFrontmatter(
    input.content.replace(bomPattern, ""),
    warnings
  );
  const headed = applyHeading(stripped);
  const dated = applyDateLine(headed, warnings);
  const title = dated.title ?? titleFromFileName(input.fileName);
  const date = dated.date ?? fallbackCreatedDate(input.created, warnings);
  const body = dated.body.trim();
  if (body.length === 0) {
    warnings.push("Empty body");
  }
  return {
    body,
    date,
    title,
    warnings,
    wordCount: countWords(body),
  };
}

function applyFrontmatter(
  content: string,
  warnings: string[]
): { body: string; date?: string; title?: string } {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return { body: content };
  }
  return {
    body: frontmatter.body,
    date: parseOptionalDate(frontmatter.date, warnings),
    title: frontmatter.title,
  };
}

function applyHeading(current: {
  body: string;
  date?: string;
  title?: string;
}): { body: string; date?: string; title?: string } {
  if (current.title) {
    return current;
  }
  const heading = extractHeading(current.body);
  if (!heading) {
    return current;
  }
  return { ...current, body: heading.body, title: heading.title };
}

function applyDateLine(
  current: { body: string; date?: string; title?: string },
  warnings: string[]
): { body: string; date?: string; title?: string } {
  const dateLine = extractDateLine(current.body);
  if (!dateLine) {
    return current;
  }
  return {
    ...current,
    body: dateLine.body,
    date: current.date ?? parseOptionalDate(dateLine.raw, warnings),
  };
}

function parseOptionalDate(
  raw: string | undefined,
  warnings: string[]
): string | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseEntryDate(raw);
  if (parsed) {
    return parsed;
  }
  warnings.push("Unrecognized date");
  return undefined;
}

function fallbackCreatedDate(created: string, warnings: string[]): string {
  if (!warnings.includes("Unrecognized date")) {
    warnings.push("No date found — using file creation date");
  }
  return created;
}

function extractFrontmatter(content: string): {
  body: string;
  date?: string;
  title?: string;
} | null {
  const lines = splitLines(content);
  if (lines[0] !== "---") {
    return null;
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return null;
  }

  let date: string | undefined;
  let title: string | undefined;
  for (let index = 1; index < end; index += 1) {
    const match = frontmatterKeyPattern.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const key = match[1]?.toLowerCase();
    const value = stripQuotes((match[2] ?? "").trim());
    if (key === "title" && value.length > 0) {
      title = value;
    }
    if (key === "date" && value.length > 0) {
      date = value;
    }
  }
  return {
    body: lines.slice(end + 1).join("\n"),
    date,
    title,
  };
}

function extractHeading(
  content: string
): { body: string; title: string } | null {
  const lines = splitLines(content);
  const limit = Math.min(lines.length, leadingScanLines);
  for (let index = 0; index < limit; index += 1) {
    const match = headingPattern.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const title = (match[1] ?? "").trim();
    if (title.length === 0) {
      continue;
    }
    return {
      body: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n"),
      title,
    };
  }
  return null;
}

function extractDateLine(
  content: string
): { body: string; raw: string } | null {
  const lines = splitLines(content);
  const limit = Math.min(lines.length, leadingScanLines);
  for (let index = 0; index < limit; index += 1) {
    const match = dateLinePattern.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const raw = (match[1] ?? "").trim();
    return {
      body: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n"),
      raw,
    };
  }
  return null;
}

function parseEntryDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (isoDatePattern.test(trimmed)) {
    return trimmed;
  }
  const parsed = parseDate(trimmed);
  if (!parsed) {
    return null;
  }
  return toEntryDate(parsed);
}

function toEntryDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function titleFromFileName(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return fileName || "Untitled";
  }
  return fileName.slice(0, lastDot) || "Untitled";
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitLines(content: string): string[] {
  return content.split(lineBreakPattern);
}
