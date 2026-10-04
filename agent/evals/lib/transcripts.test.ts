import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendChatTranscript,
  loadChatTranscripts,
  type ChatTranscript,
} from "./transcripts.ts";

test("loadChatTranscripts returns an empty list when the env var is unset", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  process.env.SAGE_EVAL_TRANSCRIPTS = "";
  try {
    assert.deepEqual(loadChatTranscripts(), []);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("loadChatTranscripts returns an empty list when the file is missing", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  process.env.SAGE_EVAL_TRANSCRIPTS = join(
    tmpdir(),
    "sage-eval-transcripts-missing.jsonl"
  );
  try {
    assert.deepEqual(loadChatTranscripts(), []);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("loadChatTranscripts returns an empty list for an empty file", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-transcripts-")),
    "chat-transcripts.jsonl"
  );
  writeFileSync(path, "");
  process.env.SAGE_EVAL_TRANSCRIPTS = path;
  try {
    assert.deepEqual(loadChatTranscripts(), []);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("appendChatTranscript writes rows that loadChatTranscripts reads back", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-transcripts-")),
    "chat-transcripts.jsonl"
  );
  process.env.SAGE_EVAL_TRANSCRIPTS = path;
  const first = sampleRow({ index: 0, reply: "first reply" });
  const second = sampleRow({
    caseId: "other",
    expectTool: true,
    index: 1,
    reply: "second reply",
  });
  try {
    appendChatTranscript(first);
    appendChatTranscript(second);
    assert.deepEqual(loadChatTranscripts(), [first, second]);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("appendChatTranscript skips the write when SAGE_EVAL_TRANSCRIPTS is unset", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  process.env.SAGE_EVAL_TRANSCRIPTS = "";
  try {
    appendChatTranscript(sampleRow());
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("loadChatTranscripts throws on a malformed line", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-transcripts-")),
    "chat-transcripts.jsonl"
  );
  writeFileSync(path, "not-json\n");
  process.env.SAGE_EVAL_TRANSCRIPTS = path;
  try {
    assert.throws(() => loadChatTranscripts(), /not valid JSON/);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

test("loadChatTranscripts keeps an empty reply", () => {
  const previous = process.env.SAGE_EVAL_TRANSCRIPTS;
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-transcripts-")),
    "chat-transcripts.jsonl"
  );
  process.env.SAGE_EVAL_TRANSCRIPTS = path;
  const row = sampleRow({ reply: "" });
  try {
    appendChatTranscript(row);
    assert.deepEqual(loadChatTranscripts(), [row]);
  } finally {
    restoreEnv("SAGE_EVAL_TRANSCRIPTS", previous);
  }
});

function sampleRow(overrides: Partial<ChatTranscript> = {}): ChatTranscript {
  return {
    caseId: "sam-example",
    expectTool: false,
    index: 0,
    model: "qwen3:8b",
    question: "Who is Sam?",
    reference: "Sam is the user's partner.",
    reply: "Sam is your partner.",
    tags: ["example", "timeline", "chat"],
    ...overrides,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
