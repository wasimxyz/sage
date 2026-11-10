// Where each pass leaves its rows, and how the runner reads them back.
//
//   <runDir>/dream/<dreamKeyId>/<person>/person.results.jsonl     person pass
//   <runDir>/setups/<setupId>/<person>/transcripts.jsonl            chat pass writes, grade pass reads
//   <runDir>/setups/<setupId>/<person>/chat.results.jsonl           chat pass
//   <runDir>/setups/<setupId>/<person>/grade.results.jsonl          grade pass
//
// Every pass has its own results file, so two grade processes never append to
// the same one. Logs sit beside them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadRecordedResults,
  type RecordedEvalResult,
} from "../../evals/lib/recorder.ts";
import {
  parseTranscriptRow,
  type TranscriptRow,
} from "../../evals/lib/schema.ts";
import type { PassName } from "./plan.ts";
import type { PassRow } from "./report.ts";

const lineBreakPattern = /\r?\n/u;

export function personPassDir(
  runDir: string,
  dreamKeyId: string,
  person: string
): string {
  return join(runDir, "dream", dreamKeyId, person);
}

export function setupPersonDir(
  runDir: string,
  setupId: string,
  person: string
): string {
  return join(runDir, "setups", setupId, person);
}

export interface PassFiles {
  dir: string;
  log: string;
  results: string;
  transcripts: string;
}

export function personPassFiles(
  runDir: string,
  dreamKeyId: string,
  person: string
): PassFiles {
  const dir = personPassDir(runDir, dreamKeyId, person);
  return {
    dir,
    log: join(dir, "person.log"),
    results: join(dir, "person.results.jsonl"),
    // The person pass does not write transcripts. The path exists so the
    // pass environment is complete.
    transcripts: join(dir, "transcripts.jsonl"),
  };
}

export function setupPassFiles(
  runDir: string,
  setupId: string,
  person: string,
  pass: "chat" | "grade"
): PassFiles {
  const dir = setupPersonDir(runDir, setupId, person);
  return {
    dir,
    log: join(dir, `${pass}.log`),
    results: join(dir, `${pass}.results.jsonl`),
    transcripts: join(dir, "transcripts.jsonl"),
  };
}

function readRows(path: string): RecordedEvalResult[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return loadRecordedResults(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not read ${path}: ${message}`);
    return [];
  }
}

/** The transcript rows in a file. A line that is not a valid row is reported and skipped. */
export function readTranscripts(path: string): TranscriptRow[] {
  if (!existsSync(path)) {
    return [];
  }
  const rows: TranscriptRow[] = [];
  const lines = readFileSync(path, "utf8").split(lineBreakPattern);
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      rows.push(parseTranscriptRow(JSON.parse(trimmed), `${path}:${offset + 1}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping a transcript row in ${path}:${offset + 1}: ${message}`);
    }
  }
  return rows;
}

export interface SetupData {
  rows: PassRow[];
  transcripts: TranscriptRow[];
}

/**
 * Everything the passes recorded for one setup across the given people: the
 * person pass for its Dream snapshot, and the chat and grade passes for it.
 */
export function collectSetupData(
  runDir: string,
  setup: { dreamKeyId: string; setupId: string },
  people: readonly string[]
): SetupData {
  const rows: PassRow[] = [];
  const transcripts: TranscriptRow[] = [];
  const add = (pass: PassName, path: string): void => {
    for (const row of readRows(path)) {
      rows.push({ pass, row });
    }
  };
  for (const person of people) {
    add(
      "person",
      personPassFiles(runDir, setup.dreamKeyId, person).results
    );
    const chat = setupPassFiles(runDir, setup.setupId, person, "chat");
    add("chat", chat.results);
    add(
      "grade",
      setupPassFiles(runDir, setup.setupId, person, "grade").results
    );
    transcripts.push(...readTranscripts(chat.transcripts));
  }
  return { rows, transcripts };
}
