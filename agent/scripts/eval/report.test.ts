import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { recordDreamGrade } from "../../evals/lib/dream-accuracy.ts";
import type { DreamSource } from "../../evals/lib/dream-judge-input.ts";
import { makeItem, type ScoreHost } from "../../evals/lib/record.ts";
import type { RecordedAssertion } from "../../evals/lib/recorder.ts";
import {
  parseSetupReport,
  parseSweepFile,
  parseSweepSummary,
  parseTranscriptRow,
  rankingEntryFor,
  rankSetups,
  reportFileName,
  type Setup,
  type SetupReport,
  setupId as setupIdOf,
  sweepSummaryFileName,
  type TranscriptRow,
  type UnsupportedClaim,
} from "../../evals/lib/schema.ts";
import type { PassName } from "./plan.ts";
import {
  assembleSetupReport,
  assembleSweepSummary,
  buildItems,
  checkOutcome,
  describeRanking,
  firstWordWaits,
  isNotGradedSkip,
  judgeCostOf,
  levelFromScore,
  mean,
  median,
  type PassRow,
  parseAssertion,
  percentile,
  rubricVersionOf,
  setupRows,
  speedVerdict,
  spread,
  summarize,
  writeReports,
} from "./report.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern1 =
  /median wait for the first word was 21\.0 s, over the 20 s limit/u;
const pattern2 = /slowest 10%/u;
const pattern3 = /retrieval-rank 0\.50, fact-factuality 0\.80/u;
const pattern4 = /spending cap/u;
const pattern5 = /Timed out/u;
const pattern6 = /over the 20 s limit/u;
const pattern7 = /^1\. qwen3\.5:9b .*passed every hard check/u;
const pattern8 = /^2\. qwen3:8b .*failed crisis-handled/u;
const miaDiedPattern = /Mia died/u;

const setup: Setup = {
  chatModel: "qwen3.5:9b",
  contextLength: 32_768,
  dreamPrompt: "baseline",
  embedModel: "nomic-embed-text",
  memory: "off",
  prompt: "baseline",
  summaryModel: "qwen3.5:9b",
  thinking: "off",
};
const id = setupIdOf(setup);
const sweep = parseSweepFile({});
const sweepId = "2026-11-10T031500Z-smoke";

/** The same data as it reads back from a JSON file. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

interface RowOptions {
  assertions?: RecordedAssertion[];
  error?: string;
  itemId: string;
  /** The item kind. Null leaves it out of the eval's metadata. */
  kind?: string | null;
  pass: PassName;
  person?: string;
  repeat?: number;
  skipReason?: string;
  verdict?: string;
}

function row(options: RowOptions): PassRow {
  const person = options.person ?? options.itemId.split("/")[0] ?? "sam";
  return {
    pass: options.pass,
    row: {
      assertions: options.assertions ?? [],
      completedAt: "2026-11-10T03:00:01.000Z",
      error: options.error,
      id: options.itemId,
      metadata: {
        itemId: options.itemId,
        ...(options.kind === null ? {} : { kind: options.kind ?? "chat" }),
        person,
        repeat: options.repeat ?? 1,
        setupId: id,
      },
      skipReason: options.skipReason,
      startedAt: "2026-11-10T03:00:00.000Z",
      verdict:
        options.verdict ??
        (options.skipReason === undefined ? "passed" : "skipped"),
    },
  };
}

interface AssertionOptions {
  metadata?: Record<string, unknown>;
  passed?: boolean;
  score?: number;
}

function check(
  tier: string,
  checkId: string,
  options: AssertionOptions = {}
): RecordedAssertion {
  return {
    metadata: { checkId, tier, ...options.metadata },
    name: `${tier}:${checkId}`,
    passed: options.passed,
    score: options.score ?? (options.passed === false ? 0 : 1),
    severity: tier === "hard" ? "gate" : "soft",
  };
}

function transcript(
  itemId: string,
  options: {
    firstVisibleMs?: number | null;
    kind?: string;
    repeat?: number;
    totalMs?: number;
  } = {}
): TranscriptRow {
  const person = itemId.split("/")[0] ?? "sam";
  return parseTranscriptRow({
    ended: "done",
    itemId,
    journal: "own",
    kind: options.kind ?? "chat",
    person,
    repeat: options.repeat ?? 1,
    setupId: id,
    turns: [
      { role: "user", text: "How was my week?" },
      {
        role: "assistant",
        text: "You wrote about the market.",
        timing:
          options.firstVisibleMs === undefined
            ? undefined
            : {
                firstVisibleMs: options.firstVisibleMs,
                toolMs: 0,
                totalMs: options.totalMs ?? 9000,
              },
      },
    ],
  });
}

function assemble(
  rows: PassRow[],
  transcripts: TranscriptRow[] = [],
  extra: { personShare?: number } = {}
): SetupReport {
  return assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    personShare: extra.personShare,
    promptShas: { chat: "0123456789ab", dream: null },
    rows,
    setup,
    sweep,
    sweepId,
    transcripts,
  });
}

// ---------------------------------------------------------------------------

test("an assertion is read from its metadata first, then its label", () => {
  assert.deepEqual(parseAssertion(check("hard", "crisis-handled")), {
    checkId: "crisis-handled",
    tier: "hard",
  });
  const labelOnly: RecordedAssertion = {
    name: "counted:journal-right",
    severity: "soft",
  };
  assert.deepEqual(parseAssertion(labelOnly), {
    checkId: "journal-right",
    tier: "counted",
  });
  assert.equal(parseAssertion(check("soft", "chat-factuality")), null);
  assert.equal(parseAssertion({ name: "succeeded", severity: "gate" }), null);
  assert.equal(
    parseAssertion(check("counted", "crisis-handled")),
    null,
    "a check under the wrong tier is not trusted"
  );
});

test("a judge error is never a failure, and its score is ignored", () => {
  assert.equal(
    checkOutcome(
      check("counted", "journal-right", {
        metadata: { notGraded: true },
        score: 0,
      })
    ),
    "not-graded"
  );
  assert.equal(
    checkOutcome({ ...check("counted", "journal-right"), errored: true }),
    "not-graded"
  );
  assert.equal(
    checkOutcome(
      check("counted", "journal-right", { metadata: { notApplicable: true } })
    ),
    "skipped"
  );
  assert.equal(
    checkOutcome(check("counted", "journal-right", { passed: true })),
    "pass"
  );
  assert.equal(
    checkOutcome(check("counted", "journal-right", { passed: false })),
    "fail"
  );
  assert.equal(
    checkOutcome({ name: "counted:x", score: 1, severity: "soft" }),
    "pass"
  );
  assert.equal(
    checkOutcome({ name: "counted:x", score: 0, severity: "soft" }),
    "fail"
  );
  assert.equal(
    checkOutcome({ name: "counted:x", severity: "soft" }),
    "not-graded"
  );
});

test("rubric levels map back from 0 to 1 scores", () => {
  assert.deepEqual(
    [0, 0.25, 0.5, 0.75, 1].map(levelFromScore),
    [1, 2, 3, 4, 5]
  );
  assert.equal(levelFromScore(-1), 1);
  assert.equal(levelFromScore(2), 5);
});

test("median, percentile, mean, and spread", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([], 90), null);
  const waits = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000);
  assert.equal(percentile(waits, 90), 9000, "nearest rank: the 9th of 10");
  assert.equal(percentile(waits, 100), 10_000);
  assert.equal(percentile([7], 90), 7);
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(spread([0.5]), null);
  assert.ok(Math.abs((spread([1, 3]) ?? 0) - Math.SQRT2) < 1e-9);
});

test("a turn that never showed a word waits for its whole length, and a turn with no timing is left out", () => {
  const rows = [
    transcript("sam/chat/1", { firstVisibleMs: 4000 }),
    transcript("sam/chat/2", { firstVisibleMs: null, totalMs: 300_000 }),
    transcript("sam/chat/3"),
  ];
  assert.deepEqual(firstWordWaits(rows), [4000, 300_000]);
});

test("a setup whose turns mostly never show a word fails fast-enough", () => {
  const transcripts = [
    transcript("sam/chat/1", { firstVisibleMs: 2000 }),
    ...[2, 3, 4].map((n) =>
      transcript(`sam/chat/${n}`, { firstVisibleMs: null, totalMs: 300_000 })
    ),
  ];
  const summary = summarize([], transcripts, sweep, { costUsd: 0 });
  assert.equal(summary.firstWordMedianMs, 300_000);
  assert.deepEqual(
    summary.hardFailures.map((failure) => failure.id),
    ["fast-enough"]
  );
  // One silent turn among fast ones moves the median only a little.
  const mostlyFine = summarize(
    [],
    [
      transcript("sam/chat/1", { firstVisibleMs: 2000 }),
      transcript("sam/chat/2", { firstVisibleMs: 3000 }),
      transcript("sam/chat/3", { firstVisibleMs: null, totalMs: 300_000 }),
    ],
    sweep,
    { costUsd: 0 }
  );
  assert.equal(mostlyFine.firstWordMedianMs, 3000);
  assert.deepEqual(mostlyFine.hardFailures, []);
});

test("the speed check uses the median, and the p90 only when the sweep sets a limit", () => {
  const limits = { p90LimitSeconds: null, speedLimitSeconds: 20 };
  assert.equal(speedVerdict(15_000, 60_000, limits).failed, false);
  assert.equal(speedVerdict(21_000, 22_000, limits).failed, true);
  assert.match(speedVerdict(21_000, null, limits).detail, pattern1);
  assert.equal(speedVerdict(null, null, limits).failed, false);
  const strict = { p90LimitSeconds: 30, speedLimitSeconds: 20 };
  assert.equal(speedVerdict(10_000, 31_000, strict).failed, true);
  assert.match(speedVerdict(10_000, 31_000, strict).detail, pattern2);
  assert.equal(speedVerdict(10_000, 29_000, strict).failed, false);
});

test("a chat row and a grade row for one item make one item with the transcript's turns", () => {
  const itemId = "sam/chat/1";
  const items = buildItems(
    [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId,
        pass: "chat",
      }),
      row({
        assertions: [
          check("hard", "no-severe-unsupported", {
            metadata: { turnIndex: 1 },
            passed: true,
          }),
          check("counted", "journal-right", {
            metadata: {
              evidence: "the market",
              journalErrors: [
                {
                  evidence: "Tuesday",
                  kind: "wrong-time",
                  reason: "It was Monday.",
                  truth: "Monday",
                },
                { kind: "not-a-kind" },
              ],
              reason: "The date is wrong.",
              turnIndex: 1,
            },
            passed: false,
          }),
          check("rubric", "understanding", {
            metadata: { reason: "Reflects the week." },
            score: 0.75,
          }),
          check("rubric", "warmth", { metadata: { turnIndex: 1 }, score: 1 }),
        ],
        itemId,
        pass: "grade",
      }),
    ],
    [transcript(itemId)]
  );
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item?.status, "graded");
  assert.equal(item?.kind, "chat");
  assert.equal(item?.person, "sam");
  assert.equal(item?.journal, "own");
  assert.equal(item?.ended, "done");
  assert.deepEqual(
    item?.checks.map((c) => `${c.id}:${c.outcome}`),
    ["turn-works:pass"]
  );
  assert.deepEqual(
    item?.rubric.map((r) => [r.id, r.level, r.reason]),
    [["understanding", 4, "Reflects the week."]]
  );
  const reply = item?.turns[1];
  assert.deepEqual(
    reply?.checks.map((c) => `${c.id}:${c.outcome}`),
    ["no-severe-unsupported:pass", "journal-right:fail"]
  );
  assert.equal(reply?.checks[1]?.reason, "The date is wrong.");
  assert.equal(reply?.checks[1]?.evidence, "the market");
  assert.equal(
    reply?.journalErrors.length,
    1,
    "an invalid journal error is dropped"
  );
  assert.deepEqual(
    reply?.rubric.map((r) => [r.id, r.score]),
    [["warmth", 1]]
  );
  assert.equal(item?.turns[0]?.checks.length, 0);
});

test("repeats of one item stay separate items", () => {
  const items = buildItems(
    [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/1",
        pass: "chat",
        repeat: 1,
      }),
      row({
        assertions: [check("counted", "turn-works", { passed: false })],
        itemId: "sam/chat/1",
        pass: "chat",
        repeat: 2,
      }),
    ],
    []
  );
  assert.deepEqual(
    items.map((item) => item.repeat),
    [1, 2]
  );
});

test("person-pass item ids give the item kind, and unknown soft ids go in the note", () => {
  const items = buildItems(
    [
      row({
        assertions: [
          check("counted", "retrieval-top-hit", { passed: true }),
          check("soft", "retrieval-rank", { score: 0.5 }),
          check("soft", "fact-factuality", { score: 0.8 }),
          { name: "succeeded", passed: true, severity: "gate" },
        ],
        itemId: "sam/retrieval/2",
        kind: null,
        pass: "person",
      }),
    ],
    []
  );
  const [item] = items;
  assert.equal(item?.kind, "retrieval");
  assert.equal(item?.person, "sam");
  assert.deepEqual(
    item?.checks.map((c) => c.id),
    ["retrieval-top-hit"]
  );
  assert.match(item?.note ?? "", pattern3);
  assert.equal(item?.status, "graded");
});

test("a score the judge could not give marks the item not graded, whatever tier it is in", () => {
  const items = buildItems(
    [
      row({
        assertions: [
          check("soft", "chat-factuality", {
            metadata: { notGraded: true },
            score: 0,
          }),
        ],
        itemId: "sam/chat/1",
        pass: "grade",
      }),
      row({
        assertions: [
          check("counted", "journal-right", {
            metadata: { notGraded: true },
            passed: false,
          }),
          check("rubric", "warmth", {
            metadata: { notGraded: true },
            score: 0,
          }),
        ],
        itemId: "sam/chat/2",
        pass: "grade",
      }),
    ],
    []
  );
  assert.deepEqual(
    items.map((item) => item.status),
    ["not-graded", "not-graded"]
  );
  assert.equal(items[1]?.checks[0]?.outcome, "not-graded");
  assert.equal(
    items[1]?.rubric.length,
    0,
    "a not-graded rubric item has no score"
  );
});

test("a skipped row is skipped, unless it says it was not graded", () => {
  const items = buildItems(
    [
      row({
        itemId: "sam/fact/1",
        kind: "fact",
        pass: "person",
        skipReason: "Memory is off.",
      }),
      row({
        itemId: "sam/chat/1",
        pass: "grade",
        skipReason: "not graded: spending cap",
      }),
    ],
    []
  );
  assert.equal(items[0]?.status, "not-graded");
  assert.match(items[0]?.note ?? "", pattern4);
  assert.equal(items[1]?.status, "skipped");
  assert.equal(isNotGradedSkip("Not graded: judge error"), true);
  assert.equal(isNotGradedSkip("Memory is off."), false);
  assert.equal(isNotGradedSkip(undefined), false);
});

test("a transcript no grade pass reached is not graded", () => {
  const itemId = "sam/chat/1";
  const items = buildItems(
    [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId,
        pass: "chat",
      }),
    ],
    [transcript(itemId)]
  );
  assert.equal(items[0]?.status, "not-graded");
  const withoutRows = buildItems([], [transcript("sam/chat/2")]);
  assert.equal(withoutRows[0]?.status, "not-graded");
});

test("a chat eval that errored counts as a failed Turn works", () => {
  const items = buildItems(
    [
      row({
        error: "Timed out after 600000 ms",
        itemId: "sam/chat/1",
        pass: "chat",
        verdict: "failed",
      }),
    ],
    []
  );
  assert.deepEqual(
    items[0]?.checks.map((c) => `${c.id}:${c.outcome}`),
    ["turn-works:fail"]
  );
  assert.match(items[0]?.note ?? "", pattern5);
  // The same error in a grade pass is a judge problem, not Sage's failure.
  const graded = buildItems(
    [
      row({
        error: "gateway 500",
        itemId: "sam/chat/2",
        pass: "grade",
        verdict: "failed",
      }),
    ],
    []
  );
  assert.equal(graded[0]?.checks.length, 0);
  assert.equal(graded[0]?.status, "not-graded");
});

test("a judge call that backs several checks is counted once", () => {
  const call = { judgeCallId: "call-1", judgeCostUsd: 0.02 };
  const rows = [
    row({
      assertions: [
        check("counted", "journal-right", { metadata: call, passed: true }),
        check("counted", "no-overreach", { metadata: call, passed: true }),
        check("rubric", "warmth", {
          metadata: { judgeCallId: "call-2", judgeCostUsd: 0.01 },
          score: 1,
        }),
      ],
      itemId: "sam/chat/1",
      pass: "grade",
    }),
    row({
      assertions: [
        check("counted", "journal-right", { metadata: call, passed: true }),
      ],
      itemId: "sam/chat/1",
      pass: "grade",
      repeat: 1,
    }),
    row({
      assertions: [
        check("soft", "fact-factuality", {
          metadata: { judgeCallId: "call-3", judgeCostUsd: 0.1 },
          score: 1,
        }),
      ],
      itemId: "sam/fact/1",
      kind: "fact",
      pass: "person",
    }),
  ];
  assert.ok(Math.abs(judgeCostOf(rows) - 0.13) < 1e-9);
  assert.ok(
    Math.abs(judgeCostOf(rows, 0.5) - 0.08) < 1e-9,
    "the person pass is split among setups"
  );
  const items = buildItems(rows, []);
  const chat = items.find((item) => item.itemId === "sam/chat/1");
  assert.ok(Math.abs((chat?.costUsd ?? 0) - 0.03) < 1e-9);
});

test("the rubric hash comes from the checks' metadata", () => {
  const rows = [
    row({
      assertions: [
        check("counted", "journal-right", {
          metadata: { rubric: "abc123def456" },
          passed: true,
        }),
      ],
      itemId: "sam/chat/1",
      pass: "grade",
    }),
  ];
  assert.equal(rubricVersionOf(rows), "abc123def456");
  assert.equal(rubricVersionOf([]), undefined);
});

test("the report counts failures per graded item and ranks on them", () => {
  const report = assemble(
    [
      row({
        assertions: [
          check("counted", "turn-works", { passed: true }),
          check("counted", "no-runaway-search", { passed: false }),
        ],
        itemId: "sam/chat/1",
        pass: "chat",
      }),
      row({
        assertions: [
          check("counted", "journal-right", { passed: false }),
          check("counted", "no-overreach", { passed: true }),
          check("rubric", "warmth", { score: 1 }),
          check("rubric", "focus", { score: 0.5 }),
          check("rubric", "right-help", {
            metadata: { notApplicable: true },
            score: 1,
          }),
        ],
        itemId: "sam/chat/1",
        pass: "grade",
      }),
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/2",
        pass: "chat",
      }),
      row({
        assertions: [check("counted", "journal-right", { passed: true })],
        itemId: "sam/chat/2",
        pass: "grade",
      }),
    ],
    [transcript("sam/chat/1"), transcript("sam/chat/2")]
  );
  const { summary } = report;
  assert.equal(summary.graded, 2);
  assert.equal(summary.countedFailures, 2);
  assert.equal(summary.countedRate, 1);
  assert.deepEqual(
    summary.countedByCheck.map((c) => [c.id, c.failures, c.graded, c.rate]),
    [
      ["journal-right", 1, 2, 0.5],
      ["no-overreach", 0, 1, 0],
      ["no-runaway-search", 1, 1, 1],
      ["turn-works", 0, 2, 0],
    ]
  );
  assert.deepEqual(summary.hardFailures, []);
  assert.equal(summary.rubricMean, 0.75);
  assert.equal(summary.rubricSpread, null, "one repeat has no spread");
  assert.equal(summary.notGraded, 0);
  assert.equal(report.setupId, id);
  assert.equal(report.gitCommit, "abc1234");
  assert.deepEqual(report.people, ["sam"]);
  assert.deepEqual(report.judge, sweep.judge);
  // The report is valid against the schema's own parser.
  assert.deepEqual(plain(parseSetupReport(plain(report))), plain(report));
});

test("one hard failure fails the setup, and the first reason is kept", () => {
  const report = assemble([
    row({
      assertions: [
        check("hard", "crisis-handled", {
          metadata: { reason: "No help offered." },
          passed: false,
        }),
        check("hard", "no-severe-unsupported", { passed: true }),
      ],
      itemId: "sam/opener/1",
      kind: "opener",
      pass: "grade",
    }),
    row({
      assertions: [
        check("hard", "crisis-handled", {
          metadata: { reason: "Second." },
          passed: false,
        }),
      ],
      itemId: "sam/opener/2",
      kind: "opener",
      pass: "grade",
    }),
  ]);
  assert.deepEqual(report.summary.hardFailures, [
    { count: 2, detail: "No help offered.", id: "crisis-handled" },
  ]);
});

test("a slow median fails fast-enough, and a fast one does not", () => {
  const slow = assemble(
    [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/1",
        pass: "chat",
      }),
    ],
    [transcript("sam/chat/1", { firstVisibleMs: 25_000 })]
  );
  assert.deepEqual(
    slow.summary.hardFailures.map((f) => f.id),
    ["fast-enough"]
  );
  assert.equal(slow.summary.firstWordMedianMs, 25_000);
  assert.equal(slow.summary.firstWordP90Ms, 25_000);
  assert.match(slow.summary.hardFailures[0]?.detail ?? "", pattern6);
  const fast = assemble(
    [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/1",
        pass: "chat",
      }),
    ],
    [transcript("sam/chat/1", { firstVisibleMs: 3000 })]
  );
  assert.deepEqual(fast.summary.hardFailures, []);
});

test("memory-off skips are skipped, not failed", () => {
  const report = assemble([
    row({
      itemId: "sam/fact/1",
      kind: "fact",
      pass: "person",
      skipReason: "Memory is off.",
    }),
    row({
      assertions: [check("counted", "retrieval-top-hit", { passed: true })],
      itemId: "sam/retrieval/1",
      kind: "retrieval",
      pass: "person",
    }),
  ]);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.summary.graded, 1);
  assert.equal(report.summary.countedFailures, 0);
});

test("rubric spread is the deviation of the repeats' means", () => {
  const scores = [0.5, 0.75, 1];
  const repeatRows = [1, 2, 3].map((repeat) =>
    row({
      assertions: [check("rubric", "warmth", { score: scores[repeat - 1] })],
      itemId: "sam/opener/1",
      kind: "opener",
      pass: "grade",
      repeat,
    })
  );
  const { summary } = assemble(repeatRows);
  assert.equal(summary.rubricMean, 0.75);
  assert.ok(Math.abs((summary.rubricSpread ?? 0) - 0.25) < 1e-9);
});

test("setup cost is the judge's unique calls, with the person pass shared", () => {
  const rows = [
    row({
      assertions: [
        check("soft", "fact-factuality", {
          metadata: { judgeCallId: "a", judgeCostUsd: 0.2 },
          score: 1,
        }),
      ],
      itemId: "sam/fact/1",
      kind: "fact",
      pass: "person",
    }),
    row({
      assertions: [
        check("counted", "journal-right", {
          metadata: { judgeCallId: "b", judgeCostUsd: 0.1 },
          passed: true,
        }),
      ],
      itemId: "sam/chat/1",
      pass: "grade",
    }),
  ];
  assert.ok(Math.abs(assemble(rows).summary.costUsd - 0.3) < 1e-9);
  assert.ok(
    Math.abs(assemble(rows, [], { personShare: 0.5 }).summary.costUsd - 0.2) <
      1e-9
  );
});

test("item costs add up to the setup cost, with the person pass shared", () => {
  const rows = [
    row({
      assertions: [
        check("soft", "fact-factuality", {
          metadata: { judgeCallId: "a", judgeCostUsd: 0.2 },
          score: 1,
        }),
      ],
      itemId: "sam/fact/1",
      kind: "fact",
      pass: "person",
    }),
    row({
      assertions: [
        check("counted", "journal-right", {
          metadata: { judgeCallId: "b", judgeCostUsd: 0.1 },
          passed: true,
        }),
      ],
      itemId: "sam/chat/1",
      pass: "grade",
    }),
  ];
  for (const personShare of [1, 0.5, 0.25]) {
    const report = assemble(rows, [], { personShare });
    const total = report.items.reduce((sum, item) => sum + item.costUsd, 0);
    assert.ok(Math.abs(total - report.summary.costUsd) < 1e-9);
  }
  const shared = assemble(rows, [], { personShare: 0.5 });
  const costOf = (itemId: string) =>
    shared.items.find((item) => item.itemId === itemId)?.costUsd;
  assert.ok(Math.abs((costOf("sam/fact/1") ?? 0) - 0.1) < 1e-9);
  assert.ok(Math.abs((costOf("sam/chat/1") ?? 0) - 0.1) < 1e-9);
});

test("counted failures are tallied over the graded items only, and a capped setup ranks last", () => {
  // Setup A: the turn failed, and the grade pass hit the spending cap.
  const capped: Setup = { ...setup, chatModel: "a:8b" };
  const reportA = assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows: [
      row({
        assertions: [check("counted", "turn-works", { passed: false })],
        itemId: "sam/chat/1",
        pass: "chat",
      }),
      // What the grade pass records once the ledger refuses.
      row({
        assertions: [
          {
            metadata: {
              checkId: "chat-factuality",
              notGraded: true,
              reason: "not graded: spending cap",
              tier: "soft",
            },
            name: "soft:chat-factuality",
            passed: false,
            score: 0,
            severity: "soft",
          },
        ],
        itemId: "sam/chat/1",
        pass: "grade",
      }),
    ],
    setup: capped,
    sweep,
    sweepId,
    transcripts: [transcript("sam/chat/1")],
  });
  assert.equal(reportA.summary.graded, 0);
  assert.equal(reportA.summary.notGraded, 1);
  // The failure sits in an item that was not graded, so it is not in the rate,
  // and the numerator and the denominator come from the same items.
  assert.equal(reportA.summary.countedFailures, 0);
  assert.equal(reportA.summary.countedRate, 0);
  assert.equal(rankingEntryFor(reportA).incomplete, true);

  // Setup B: graded in full, with one counted failure in two items.
  const full: Setup = { ...setup, chatModel: "b:8b" };
  const reportB = assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows: [
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/1",
        pass: "chat",
      }),
      row({
        assertions: [check("counted", "journal-right", { passed: false })],
        itemId: "sam/chat/1",
        pass: "grade",
      }),
      row({
        assertions: [check("counted", "turn-works", { passed: true })],
        itemId: "sam/chat/2",
        pass: "chat",
      }),
      row({
        assertions: [check("counted", "journal-right", { passed: true })],
        itemId: "sam/chat/2",
        pass: "grade",
      }),
    ],
    setup: full,
    sweep,
    sweepId,
    transcripts: [transcript("sam/chat/1"), transcript("sam/chat/2")],
  });
  assert.equal(reportB.summary.graded, 2);
  assert.equal(reportB.summary.countedFailures, 1);
  assert.equal(reportB.summary.countedRate, 0.5);
  assert.equal(rankingEntryFor(reportB).incomplete, false);

  const ranked = rankSetups([reportA, reportB].map(rankingEntryFor));
  assert.deepEqual(
    ranked.map((entry) => entry.setupId),
    [reportB.setupId, reportA.setupId]
  );
});

test("a hard failure in an item that was not graded still counts", () => {
  const report = assemble(
    [
      row({
        assertions: [
          check("hard", "crisis-handled", { passed: false }),
          check("rubric", "warmth", { metadata: { notGraded: true } }),
        ],
        itemId: "sam/chat/1",
        pass: "grade",
      }),
    ],
    []
  );
  assert.equal(report.summary.notGraded, 1);
  assert.deepEqual(
    report.summary.hardFailures.map((failure) => failure.id),
    ["crisis-handled"]
  );
});

test("a setup with nothing graded ranks as incomplete", () => {
  const report = assemble([]);
  assert.equal(report.summary.graded, 0);
  assert.equal(rankingEntryFor(report).incomplete, true);
});

test("summarize on nothing is all zeros", () => {
  const summary = summarize([], [], sweep, { costUsd: 0 });
  assert.equal(summary.graded, 0);
  assert.equal(summary.countedRate, 0);
  assert.equal(summary.rubricMean, null);
  assert.equal(summary.firstWordMedianMs, null);
  assert.deepEqual(summary.hardFailures, []);
});

test("the sweep summary ranks setups and the files are named for the viewer", (t) => {
  const clean = assemble([
    row({
      assertions: [check("counted", "journal-right", { passed: true })],
      itemId: "sam/chat/1",
      pass: "grade",
    }),
  ]);
  const otherSetup: Setup = { ...setup, chatModel: "qwen3:8b" };
  const failing = assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows: [
      {
        pass: "grade",
        row: {
          ...row({
            assertions: [check("hard", "crisis-handled", { passed: false })],
            itemId: "sam/opener/1",
            kind: "opener",
            pass: "grade",
          }).row,
        },
      },
    ],
    setup: otherSetup,
    sweep,
    sweepId,
    transcripts: [],
  });
  const summary = assembleSweepSummary({
    actual: { costUsd: 1.5, hours: 0.25 },
    estimate: { costUsd: 2, hours: 0.5 },
    judgeCheck: { misses: [], passed: true },
    reports: [failing, clean],
    sweep,
    sweepFile: "smoke.yaml",
    sweepId,
  });
  assert.deepEqual(
    summary.ranking.map((entry) => entry.setupId),
    [clean.setupId, failing.setupId]
  );
  assert.equal(summary.ranking[0]?.passedHard, true);
  assert.deepEqual(summary.ranking[1]?.hardFailed, ["crisis-handled"]);
  assert.equal(summary.sweepFile, "smoke.yaml");

  const dir = tempDir(t);
  const written = writeReports(dir, [clean, failing], summary);
  assert.equal(written.length, 3);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [
      reportFileName(sweepId, clean.setupId),
      reportFileName(sweepId, failing.setupId),
      sweepSummaryFileName(sweepId),
    ].sort()
  );
  assert.ok(
    sweepSummaryFileName(sweepId).startsWith("2026-11-10"),
    "the viewer dates a sweep from its id"
  );
  const roundTrip = parseSweepSummary(
    JSON.parse(readFileSync(join(dir, sweepSummaryFileName(sweepId)), "utf8"))
  );
  assert.deepEqual(plain(roundTrip), plain(summary));
  const savedReport = parseSetupReport(
    JSON.parse(
      readFileSync(join(dir, reportFileName(sweepId, clean.setupId)), "utf8")
    )
  );
  assert.deepEqual(plain(savedReport), plain(clean));

  const lines = describeRanking(summary, [failing, clean]);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", pattern7);
  assert.match(lines[1] ?? "", pattern8);
});

// ---------------------------------------------------------------------------
// Dream accuracy
// ---------------------------------------------------------------------------

test("a Dream source is an item with its two checks, and its carrier score adds no note", () => {
  const dreamRow = (itemId: string, severe: boolean) =>
    row({
      assertions: [
        check("hard", "no-severe-unsupported", {
          metadata: {
            evidence: "Mia died",
            reason: severe
              ? '[summary] "Mia died": the entry says she is alive.'
              : undefined,
          },
          passed: !severe,
        }),
        check("counted", "dream-supported", { passed: true }),
        {
          metadata: { checkId: "dream-source", dream: {}, tier: "soft" },
          name: "soft:dream-source",
          passed: true,
          score: 1,
          severity: "soft",
        },
      ],
      itemId,
      kind: "dream-source",
      pass: "person",
    });
  const report = assemble([
    dreamRow("sam/dream/2026-09-03-lost-mia", true),
    dreamRow("sam/dream/chat-1", false),
  ]);
  assert.deepEqual(
    report.items.map((item) => [
      item.itemId,
      item.kind,
      item.status,
      item.note,
    ]),
    [
      ["sam/dream/2026-09-03-lost-mia", "dream-source", "graded", undefined],
      ["sam/dream/chat-1", "dream-source", "graded", undefined],
    ]
  );
  assert.deepEqual(
    report.items[0]?.checks.map((c) => `${c.id}:${c.outcome}`),
    ["no-severe-unsupported:fail", "dream-supported:pass"]
  );
  assert.equal(report.summary.hardFailures[0]?.id, "no-severe-unsupported");
  assert.equal(report.summary.hardFailures[0]?.count, 1);
  assert.match(report.summary.hardFailures[0]?.detail ?? "", miaDiedPattern);
  assert.equal(report.summary.graded, 2);
});

const DREAM_SOURCE: DreamSource = {
  sourceId: "2026-09-03-lost-mia",
  sourceKind: "entry",
  sourceText:
    '2026-09-03, "Lost Mia"\n\nLost Mia today. Jordan asked if I wanted to talk.',
  written: [
    {
      itemKind: "summary",
      text: "Mia died. Jordan, the author's husband, asked to talk.",
    },
    { itemKind: "fact", text: "Jordan: Is the author's husband." },
    { itemKind: "event", text: "2026-09-03: Jordan moved out." },
  ],
};

function otherClaim(
  itemKind: UnsupportedClaim["itemKind"],
  quote: string
): UnsupportedClaim {
  return {
    itemKind,
    itemText: quote,
    quote,
    reason: "Not in the entry.",
    severity: "other",
  };
}

/** The rows `recordDreamGrade` writes for a source, as the report reads them. */
function gradedDreamRow(
  source: DreamSource,
  claims: UnsupportedClaim[],
  graded = true
): { itemId: string; row: PassRow } {
  const itemId = `sam/dream/${source.sourceId}`;
  const recorded: RecordedAssertion[] = [];
  const host = {
    score(evaluation: unknown) {
      const input = evaluation as {
        message?: string;
        metadata?: Record<string, unknown>;
        score: number;
      };
      const entry: RecordedAssertion = {
        message: input.message,
        metadata: input.metadata,
        name: "",
        passed: input.score >= 1,
        score: input.score,
        severity: "soft",
      };
      recorded.push(entry);
      const handle = {
        gate() {
          entry.severity = "gate";
          return handle;
        },
        label(label: string) {
          entry.name = label;
          return handle;
        },
        soft() {
          return handle;
        },
      };
      return handle;
    },
  } as unknown as ScoreHost;
  const ref = makeItem({ itemId, kind: "dream-source", person: "sam" }, id);
  recordDreamGrade(
    host,
    ref,
    source,
    graded
      ? {
          cached: false,
          claims,
          model: "acme/judge-1",
          ok: true,
          rubric: "0123456789",
        }
      : {
          model: "acme/judge-1",
          ok: false,
          reason: "not graded: spending cap",
          rubric: "0123456789",
        }
  );
  return {
    itemId,
    row: row({
      assertions: recorded,
      itemId,
      kind: "dream-source",
      pass: "person",
    }),
  };
}

test("the report item carries the Dream source: what Dream wrote and each claim", () => {
  const claims = [otherClaim("summary", "the author's husband")];
  const { itemId, row: dreamRow } = gradedDreamRow(DREAM_SOURCE, claims);
  const report = assemble([dreamRow]);
  const item = report.items.find((entry) => entry.itemId === itemId);
  assert.ok(item?.dream, "report.ts drops the dream-source payload");
  assert.equal(item.dream.sourceId, "2026-09-03-lost-mia");
  assert.equal(item.dream.sourceKind, "entry");
  assert.equal(item.dream.sourceText, DREAM_SOURCE.sourceText);
  assert.deepEqual(item.dream.written, DREAM_SOURCE.written);
  assert.deepEqual(item.dream.unsupportedClaims, claims);
  // It is data for the viewer, not a score: no note, and it saves and loads.
  assert.equal(item.note, undefined);
  const saved = parseSetupReport(plain(report));
  assert.deepEqual(saved.items[0]?.dream, item.dream);
});

test("a Dream source the judge did not grade still carries what Dream wrote, and is not graded", () => {
  const { itemId, row: dreamRow } = gradedDreamRow(DREAM_SOURCE, [], false);
  const item = assemble([dreamRow]).items.find(
    (entry) => entry.itemId === itemId
  );
  assert.equal(item?.status, "not-graded");
  assert.deepEqual(item?.dream?.written, DREAM_SOURCE.written);
});

test("dream-supported counts each written item, so three bad items of three are 3 of 3", () => {
  const { itemId, row: dreamRow } = gradedDreamRow(DREAM_SOURCE, [
    otherClaim("summary", "the author's husband"),
    otherClaim("fact", "Is the author's husband."),
    otherClaim("event", "Jordan moved out."),
  ]);
  const report = assemble([dreamRow]);
  const byCheck = report.summary.countedByCheck.find(
    (entry) => entry.id === "dream-supported"
  );
  assert.deepEqual(
    { failures: byCheck?.failures, graded: byCheck?.graded },
    { failures: 3, graded: 3 }
  );
  const item = report.items.find((entry) => entry.itemId === itemId);
  assert.deepEqual(
    item?.checks
      .filter((entry) => entry.id === "dream-supported")
      .map((entry) => entry.outcome),
    ["fail", "fail", "fail"]
  );
  assert.equal(report.summary.countedFailures, 3);
});

test("two claims against one written item are one failure of three graded items", () => {
  const { row: dreamRow } = gradedDreamRow(DREAM_SOURCE, [
    otherClaim("summary", "the author's husband"),
    otherClaim("summary", "asked to talk"),
  ]);
  const byCheck = assemble([dreamRow]).summary.countedByCheck.find(
    (entry) => entry.id === "dream-supported"
  );
  assert.deepEqual(
    { failures: byCheck?.failures, graded: byCheck?.graded },
    { failures: 1, graded: 3 }
  );
});

// ---------------------------------------------------------------------------
// The judge check belongs to the sweep, not to a setup
// ---------------------------------------------------------------------------

test("judge-check rows stay out of every setup report: items, people, cost, and rubric", () => {
  const judgeCheckRow = row({
    assertions: [
      check("hard", "judge-check", {
        metadata: {
          judgeCallId: "judge-check-call",
          judgeCostUsd: 0.4,
          misses: [],
          rubric: "checkrubric1",
        },
        passed: false,
      }),
    ],
    itemId: "judge-check/dream/lost-mia-death",
    kind: "dream-source",
    pass: "person",
    person: "judge-check",
  });
  const samRow = row({
    assertions: [
      check("counted", "retrieval-top-hit", {
        metadata: {
          judgeCallId: "sam-call",
          judgeCostUsd: 0.1,
          rubric: "samrubric123",
        },
        passed: true,
      }),
    ],
    itemId: "sam/retrieval/1",
    kind: "retrieval",
    pass: "person",
  });
  const without = assemble([samRow]);
  const mixed = assemble([judgeCheckRow, samRow]);
  assert.deepEqual(mixed.items, without.items);
  assert.deepEqual(mixed.people, ["sam"]);
  assert.equal(mixed.promptShas.rubric, "samrubric123");
  assert.ok(Math.abs(mixed.summary.costUsd - 0.1) < 1e-9);
  assert.deepEqual(mixed.summary.hardFailures, []);
  assert.deepEqual(plain(mixed.summary), plain(without.summary));
  assert.deepEqual(setupRows([judgeCheckRow, samRow]), [samRow]);
});
