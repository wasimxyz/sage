import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EveEvalResult } from "eve/evals";
import type { EveEvalCompleteContext } from "eve/evals/reporters";

import { loadRecordedResults, sageEvalRecorder } from "./recorder.ts";

test("loadRecordedResults returns an empty list when the file is missing", () => {
  assert.deepEqual(
    loadRecordedResults(join(tmpdir(), "sage-eval-results-missing.jsonl")),
    []
  );
});

test("sageEvalRecorder writes rows that loadRecordedResults reads back", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-results-")),
    "eval-results.jsonl"
  );
  const reporter = sageEvalRecorder(path);
  reporter.onEvalComplete(
    sampleResult({
      id: "chat/0000",
      verdict: "passed",
    }),
    sampleContext({
      caseId: "sam-example",
      index: 0,
      question: "Who is Sam?",
      reference: "Sam is the user's partner.",
    })
  );
  reporter.onEvalComplete(
    sampleResult({
      assertions: [
        {
          errored: false,
          metadata: { output: "Sam is your partner." },
          name: "chat factuality",
          passed: true,
          score: 1,
          severity: "soft",
        },
      ],
      completedAt: "2026-09-16T22:00:03.000Z",
      id: "chat-judge/0000",
      startedAt: "2026-09-16T22:00:02.000Z",
      verdict: "passed",
    })
  );
  const rows = loadRecordedResults(path);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, "chat/0000");
  assert.equal(rows[0]?.metadata.caseId, "sam-example");
  assert.equal(rows[0]?.metadata.index, 0);
  assert.equal(rows[1]?.id, "chat-judge/0000");
  assert.equal(rows[1]?.assertions[0]?.name, "chat factuality");
});

test("loadRecordedResults throws on a malformed line", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-eval-results-")),
    "eval-results.jsonl"
  );
  const reporter = sageEvalRecorder(path);
  reporter.onEvalComplete(sampleResult({ id: "chat/0000" }));
  appendFileSync(path, "not-json\n");
  assert.throws(() => loadRecordedResults(path), /not valid JSON/);
});

function sampleResult(
  overrides: Partial<EveEvalResult> = {}
): EveEvalResult {
  return {
    assertions: overrides.assertions ?? [
      {
        errored: false,
        name: "succeeded",
        passed: true,
        score: 1,
        severity: "gate",
      },
    ],
    completedAt: overrides.completedAt ?? "2026-09-16T22:00:01.000Z",
    error: overrides.error,
    id: overrides.id ?? "chat/0000",
    result: {
      derived: {
        inputRequests: [],
        messageCount: 1,
        parked: false,
        reasoningBlockCount: 0,
        subagentCallCount: 0,
        subagentCalls: [],
        toolCallCount: 0,
        toolCalls: [],
      },
      events: [],
      finalMessage: "ok",
      output: "ok",
      status: "waiting",
      traceContexts: [],
    },
    skipReason: overrides.skipReason,
    startedAt: overrides.startedAt ?? "2026-09-16T22:00:00.000Z",
    verdict: overrides.verdict ?? "passed",
  };
}

function sampleContext(
  metadata: Record<string, unknown>
): EveEvalCompleteContext {
  return {
    evaluation: {
      _tag: "EveEval",
      id: "chat/0000",
      metadata,
      test() {},
    },
    target: {
      capabilities: { devRoutes: true },
      kind: "local",
      url: "http://127.0.0.1:0",
    },
    traceContexts: [],
  };
}
