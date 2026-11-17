import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENV_TRANSCRIPTS,
  itemIdFor,
  parseTranscriptRow,
  SchemaError,
  type TranscriptRow,
} from "./schema.ts";
import {
  appendTranscript,
  loadTranscripts,
  transcriptPath,
} from "./transcripts.ts";

const notValidJSONPattern = /not valid JSON/u;

function tempPath(name = "transcripts.jsonl"): string {
  return join(mkdtempSync(join(tmpdir(), "sage-eval-transcripts-")), name);
}

function sampleRow(overrides: Partial<TranscriptRow> = {}): TranscriptRow {
  return parseTranscriptRow({
    ended: "done",
    itemId: itemIdFor("sam-example", "chat", 1),
    journal: "own",
    kind: "chat",
    person: "sam-example",
    repeat: 1,
    setupId: "0123456789",
    turns: [
      { role: "user", text: "Who is Sam?" },
      {
        role: "assistant",
        stepModelIds: ["qwen3:8b"],
        text: "Sam is your partner.",
        timing: { firstVisibleMs: 900, toolMs: 120, totalMs: 2100 },
        toolCalls: [
          {
            input: { query: "Sam" },
            name: "search_journal",
            output: { entries: [] },
            status: "completed",
          },
        ],
      },
    ],
    ...overrides,
  });
}

test("transcriptPath reads SAGE_EVAL_TRANSCRIPTS and treats empty as unset", () => {
  assert.equal(
    transcriptPath({ [ENV_TRANSCRIPTS]: "/tmp/t.jsonl" }),
    "/tmp/t.jsonl"
  );
  assert.equal(transcriptPath({ [ENV_TRANSCRIPTS]: "" }), undefined);
  assert.equal(transcriptPath({}), undefined);
});

test("loadTranscripts returns an empty list with no path or no file", () => {
  assert.deepEqual(loadTranscripts(undefined), []);
  assert.deepEqual(loadTranscripts(tempPath()), []);
});

test("loadTranscripts returns an empty list for an empty file", () => {
  const path = tempPath();
  writeFileSync(path, "");
  assert.deepEqual(loadTranscripts(path), []);
});

test("appendTranscript writes rows that loadTranscripts reads back in order", () => {
  const path = tempPath();
  const first = sampleRow();
  const second = sampleRow({
    itemId: itemIdFor("sam-example", "chat", 2),
    repeat: 2,
  });
  appendTranscript(first, path);
  appendTranscript(second, path);
  assert.deepEqual(loadTranscripts(path), [first, second]);
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 2);
});

test("appendTranscript creates the folder", () => {
  const path = join(tempPath("nested"), "deeper", "transcripts.jsonl");
  appendTranscript(sampleRow(), path);
  assert.equal(loadTranscripts(path).length, 1);
});

test("appendTranscript does nothing without a path", () => {
  appendTranscript(sampleRow(), undefined);
});

test("appendTranscript rejects a row that does not match the schema", () => {
  const path = tempPath();
  const bad = { ...sampleRow(), setupId: "short" } as TranscriptRow;
  assert.throws(() => appendTranscript(bad, path), SchemaError);
  assert.deepEqual(loadTranscripts(path), []);
});

test("loadTranscripts throws on a line that is not JSON, naming the line", () => {
  const path = tempPath();
  appendTranscript(sampleRow(), path);
  writeFileSync(path, `${readFileSync(path, "utf8")}not-json\n`);
  assert.throws(
    () => loadTranscripts(path),
    (error: unknown) =>
      error instanceof Error &&
      notValidJSONPattern.test(error.message) &&
      error.message.includes(`${path}:2`)
  );
});

test("loadTranscripts throws on a row that does not match the schema, naming the line", () => {
  const path = tempPath();
  writeFileSync(path, `${JSON.stringify({ itemId: "x" })}\n`);
  assert.throws(
    () => loadTranscripts(path),
    (error: unknown) =>
      error instanceof SchemaError && error.message.includes(`${path}:1`)
  );
});

test("loadTranscripts keeps an assistant turn with an empty reply and an error", () => {
  const path = tempPath();
  const row = sampleRow({
    ended: "error",
    turns: [
      { role: "user", stepModelIds: [], text: "Hi", toolCalls: [] },
      {
        error: "Stream closed before a turn boundary.",
        role: "assistant",
        stepModelIds: [],
        text: "",
        toolCalls: [],
      },
    ],
  });
  appendTranscript(row, path);
  assert.deepEqual(loadTranscripts(path), [row]);
});
