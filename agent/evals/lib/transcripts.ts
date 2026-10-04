import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const lineBreakPattern = /\r?\n/;

export interface ChatTranscript {
  caseId: string;
  expectTool: boolean;
  index: number;
  model: string;
  question: string;
  reference: string;
  reply: string;
  tags: string[];
}

export function transcriptPath(): string | undefined {
  const path = process.env.SAGE_EVAL_TRANSCRIPTS;
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  return path;
}

export function appendChatTranscript(row: ChatTranscript): void {
  const path = transcriptPath();
  if (path === undefined) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

export function loadChatTranscripts(): ChatTranscript[] {
  const path = process.env.SAGE_EVAL_TRANSCRIPTS;
  if (path === undefined || path.length === 0) {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const rows: ChatTranscript[] = [];
  const lines = raw.split(lineBreakPattern);
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(trimmed, path, offset + 1));
  }
  return rows;
}

function parseRow(
  line: string,
  path: string,
  lineNumber: number
): ChatTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`${path}:${lineNumber} is not valid JSON.`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path}:${lineNumber} must be a JSON object.`);
  }
  const row = parsed as Record<string, unknown>;
  const label = `${path}:${lineNumber}`;
  return {
    caseId: requiredString(row, "caseId", label),
    expectTool: row.expectTool === true,
    index: requiredInt(row, "index", label),
    model: requiredString(row, "model", label),
    question: requiredString(row, "question", label),
    reference: requiredString(row, "reference", label),
    reply: requiredStringField(row, "reply", label),
    tags: stringList(row.tags, label),
  };
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value;
}

function requiredStringField(
  row: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value;
}

function requiredInt(
  row: Record<string, unknown>,
  key: string,
  label: string
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} is missing integer ${key}.`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !(Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    throw new Error(`${label} tags must be a list of strings.`);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
