/**
 * The transcript file that joins generation to grading.
 *
 * A generation pass (`eve eval chat`) appends one `TranscriptRow` per item and
 * repeat to the file named by `SAGE_EVAL_TRANSCRIPTS`, one JSON object per
 * line. A grade pass (`eve eval grade`) reads those rows back and judges them.
 * Both passes use the same row shape, `TranscriptRow` in `schema.ts`.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ENV_TRANSCRIPTS,
  parseTranscriptRow,
  type TranscriptRow,
} from "./schema.ts";

const lineBreakPattern = /\r?\n/u;

/** The transcript file for this pass, or `undefined` when none is set. */
export function transcriptPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const path = env[ENV_TRANSCRIPTS];
  return path === undefined || path.length === 0 ? undefined : path;
}

/**
 * Appends one row. The row is checked against the schema first, so a bad row
 * fails in the generation pass that made it and not in the grade pass later.
 * Without a transcript path this does nothing, so a bare `eve eval` still runs.
 */
export function appendTranscript(
  row: TranscriptRow,
  path: string | undefined = transcriptPath()
): void {
  if (path === undefined) {
    return;
  }
  const checked = parseTranscriptRow(row, `transcript row ${row.itemId}`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(checked)}\n`, "utf8");
}

/**
 * Reads every row, in file order. A missing file or no path gives an empty
 * list. A line that is not JSON or not a valid row throws an error that names
 * the file and line.
 */
export function loadTranscripts(
  path: string | undefined = transcriptPath()
): TranscriptRow[] {
  if (path === undefined) {
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
  const rows: TranscriptRow[] = [];
  for (const [offset, line] of raw.split(lineBreakPattern).entries()) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      rows.push(parseLine(trimmed, `${path}:${offset + 1}`));
    }
  }
  return rows;
}

function parseLine(line: string, where: string): TranscriptRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`${where} is not valid JSON.`, { cause: error });
  }
  return parseTranscriptRow(parsed, `transcript row at ${where}`);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
