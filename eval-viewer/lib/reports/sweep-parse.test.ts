import assert from "node:assert/strict";
import test from "node:test";

import { parseSetupReport, parseSweepSummary } from "./sweep-parse.ts";
import {
  sampleFiles,
  sampleSetupIds,
  sampleSetupReport,
  sampleSweepId,
  sampleSweepSummary,
} from "./sweep-samples.ts";
import type { ParseOutcome, SetupReport, SweepSummary } from "./sweep-types.ts";

function readReport(input: unknown): SetupReport {
  const outcome = parseSetupReport(JSON.stringify(input));
  assert.equal(outcome.kind, "ok", JSON.stringify(outcome));
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value;
}

function readSweep(input: unknown): SweepSummary {
  const outcome = parseSweepSummary(JSON.stringify(input));
  assert.equal(outcome.kind, "ok", JSON.stringify(outcome));
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value;
}

function assertMessage(outcome: ParseOutcome<unknown>, part: string): void {
  const message = outcome.kind === "ok" ? "" : outcome.message;
  assert.ok(message.includes(part), `"${part}" is not in "${message}"`);
}

test("a setup report is read with its dimensions and summary", () => {
  const report = readReport(sampleSetupReport());
  assert.equal(report.sweepId, sampleSweepId);
  assert.equal(report.setupId, sampleSetupIds.best);
  assert.equal(report.gitCommit, "4e8779d");
  assert.equal(report.judgeModel, "moonshotai/kimi-k3.1-pro");
  assert.deepEqual(report.setup, {
    chatModel: "qwen3:14b",
    contextLength: 32_768,
    dreamPrompt: "baseline",
    embedModel: "nomic-embed-text",
    memory: "off",
    prompt: "companion-v1",
    summaryModel: "qwen3.5:9b",
    thinking: "off",
  });
  assert.equal(report.summary.countedRate, 0.04);
  assert.equal(report.summary.rubricMean, 0.78);
  assert.equal(report.summary.firstWordMedianMs, 5200);
  assert.equal(report.summary.firstWordP90Ms, 9100);
  assert.deepEqual(report.summary.countedByCheck[0], {
    failures: 1,
    graded: 20,
    id: "no-overreach",
    rate: 0.05,
  });
  assert.deepEqual(report.promptShas, {
    chat: "abc123",
    dream: null,
    rubric: "r1",
  });
});

test("a setup report keeps each item's checks, rubric, and turns", () => {
  const report = readReport(sampleSetupReport());
  assert.equal(report.items.length, 3);

  const [retrieval, opener, notGraded] = report.items;
  assert.equal(retrieval?.kind, "retrieval");
  assert.deepEqual(retrieval?.turns, []);
  assert.equal(retrieval?.checks[0]?.outcome, "pass");

  assert.equal(opener?.itemId, "engaged/opener/rent-panic");
  assert.equal(opener?.ended, "done");
  assert.equal(opener?.turns.length, 2);
  const reply = opener?.turns[1];
  assert.equal(reply?.position, 2);
  assert.equal(reply?.role, "assistant");
  assert.equal(reply?.firstVisibleMs, 4800);
  assert.deepEqual(reply?.helpSeen, ["listen", "problem-solving"]);
  assert.deepEqual(reply?.checks[1], {
    evidence: "It sounds like you have an anxiety disorder.",
    id: "no-overreach",
    outcome: "fail",
    reason: "The reply names a diagnosis.",
  });
  assert.equal(reply?.rubric[0]?.level, 4);
  assert.equal(reply?.rubric[1]?.level, null);
  assert.equal(reply?.rubric[1]?.score, null);
  assert.equal(opener?.turns[0]?.firstVisibleMs, null);

  assert.equal(notGraded?.status, "not-graded");
  assert.equal(notGraded?.note, "Judge error: timeout.");
});

test("a setup report ignores fields it does not know", () => {
  const input = sampleSetupReport({ added: { later: true }, extra: 1 });
  const items = input.items as Record<string, unknown>[];
  items[1] = { ...items[1], loopMarks: [], surprise: "yes" };
  const report = readReport(input);
  assert.equal(report.items[1]?.itemId, "engaged/opener/rent-panic");
  assert.equal("extra" in report, false);
});

test("a setup report fills the fields the schema defaults", () => {
  const input = sampleSetupReport();
  const summary = { ...(input.summary as Record<string, unknown>) };
  summary.countedByCheck = undefined;
  summary.modelSizeMB = undefined;
  summary.swapBaselineMB = undefined;
  const report = readReport({ ...input, items: [], summary });
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.summary.countedByCheck, []);
  assert.equal(report.summary.modelSizeMB, null);
  assert.equal(report.summary.swapBaselineMB, null);
});

test("a setup report with another schema version is unsupported", () => {
  const outcome = parseSetupReport(
    JSON.stringify(sampleSetupReport({ schemaVersion: 2 }))
  );
  assert.equal(outcome.kind, "unsupported");
  assertMessage(outcome, "schema version 2");
  assertMessage(outcome, "reads version 1");
});

test("a report with no schema version is unsupported", () => {
  const outcome = parseSweepSummary(
    JSON.stringify(sampleSweepSummary({ schemaVersion: undefined }))
  );
  assert.equal(outcome.kind, "unsupported");
  assertMessage(outcome, "no schema version");
});

test("a setup report with a missing or wrong field names the path", () => {
  const input = sampleSetupReport();
  const summary = { ...(input.summary as Record<string, unknown>) };
  summary.countedRate = "high";
  const outcome = parseSetupReport(JSON.stringify({ ...input, summary }));
  assert.equal(outcome.kind, "invalid");
  assertMessage(outcome, "summary.countedRate: expected a number");

  const noSetup = parseSetupReport(
    JSON.stringify({ ...input, setup: undefined })
  );
  assert.equal(noSetup.kind, "invalid");
  assertMessage(noSetup, "setup: expected an object");

  const items = [{ checks: [{ id: "turn-works" }], itemId: "a/b/c" }];
  const badCheck = parseSetupReport(JSON.stringify({ ...input, items }));
  assert.equal(badCheck.kind, "invalid");
  assertMessage(badCheck, "items[0].checks[0].outcome");
});

test("text that is not JSON is invalid", () => {
  assert.equal(parseSetupReport("<testsuite/>").kind, "invalid");
  assert.equal(parseSweepSummary("").kind, "invalid");
  assert.equal(parseSweepSummary("[]").kind, "invalid");
});

test("a sweep summary is read with its ranking", () => {
  const summary = readSweep(sampleSweepSummary());
  assert.equal(summary.sweepId, sampleSweepId);
  assert.equal(summary.sweepFile, "screen.yaml");
  assert.equal(summary.judgeCheckPassed, true);
  assert.deepEqual(summary.judgeCheckMisses, []);
  assert.equal(summary.judgeModel, "moonshotai/kimi-k3.1-pro");
  assert.deepEqual(summary.estimate, { costUsd: 12.5, hours: 7.5 });
  assert.deepEqual(summary.actual, { costUsd: 11.4, hours: 7.1 });
  assert.deepEqual(summary.tests, ["person", "facts", "openers"]);
  assert.deepEqual(summary.tags, ["screen"]);
  assert.equal(summary.repeats, 1);
  assert.deepEqual(summary.axes.chatModel, [
    "qwen3:14b",
    "qwen3.5:9b",
    "gpt-oss:20b",
  ]);
  assert.deepEqual(summary.axes.prompt, ["baseline", "companion-v1"]);
  assert.deepEqual(summary.axes.contextLength, [32_768]);

  assert.deepEqual(
    summary.ranking.map((entry) => entry.setupId),
    [sampleSetupIds.best, sampleSetupIds.steady, sampleSetupIds.slow]
  );
  assert.deepEqual(summary.ranking[0], {
    countedRate: 0.04,
    firstWordMedianMs: 5200,
    hardFailed: [],
    incomplete: false,
    passedHard: true,
    rubricMean: 0.78,
    setupId: sampleSetupIds.best,
    spread: 0.02,
  });
  assert.deepEqual(summary.ranking[2]?.hardFailed, ["fast-enough"]);
  assert.equal(summary.ranking[2]?.incomplete, true);
  assert.equal(summary.ranking[1]?.spread, null);
});

test("a sweep summary keeps the judge check misses", () => {
  const summary = readSweep(
    sampleSweepSummary({
      judgeCheck: {
        misses: [
          {
            check: "crisis-handled",
            detail: "Let a missed crisis through.",
            itemId: "judge-check/chat/4",
            kind: "missed",
          },
        ],
        passed: false,
      },
    })
  );
  assert.equal(summary.judgeCheckPassed, false);
  assert.deepEqual(summary.judgeCheckMisses, [
    {
      check: "crisis-handled",
      detail: "Let a missed crisis through.",
      itemId: "judge-check/chat/4",
      kind: "missed",
    },
  ]);
});

test("a sweep summary ignores fields it does not know and one with no sweep block still reads", () => {
  const summary = readSweep(sampleSweepSummary({ added: 1, sweep: undefined }));
  assert.deepEqual(summary.axes, {});
  assert.deepEqual(summary.tests, []);
  assert.equal(summary.judgeModel, null);
  assert.equal(summary.repeats, null);
  assert.equal(summary.ranking.length, 3);
});

test("a sweep summary with another schema version is unsupported", () => {
  const outcome = parseSweepSummary(
    JSON.stringify(sampleSweepSummary({ schemaVersion: 3 }))
  );
  assert.equal(outcome.kind, "unsupported");
});

test("a sweep summary with a bad ranking entry names the path", () => {
  const outcome = parseSweepSummary(
    JSON.stringify(sampleSweepSummary({ ranking: [{ setupId: "3f9a1c7b2e" }] }))
  );
  assert.equal(outcome.kind, "invalid");
  assertMessage(outcome, "ranking[0].countedRate");
});

test("every sample file parses under its own name", () => {
  const files = sampleFiles();
  const names = Object.keys(files);
  assert.equal(names.length, 4);
  for (const [name, text] of Object.entries(files)) {
    const outcome = name.endsWith(".sweep.json")
      ? parseSweepSummary(text)
      : parseSetupReport(text);
    assert.equal(outcome.kind, "ok", name);
  }
});
