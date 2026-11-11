import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { RecordedAssertion } from "../../evals/lib/recorder.ts";
import {
  parseSetupReport,
  parseSweepFile,
  parseSweepSummary,
  parseTranscriptRow,
  reportFileName,
  type Setup,
  type SetupReport,
  setupId as setupIdOf,
  sweepSummaryFileName,
  type TranscriptRow,
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
                totalMs: 9000,
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

test("first-word waits come from assistant turns that showed a word", () => {
  const rows = [
    transcript("sam/chat/1", { firstVisibleMs: 4000 }),
    transcript("sam/chat/2", { firstVisibleMs: null }),
    transcript("sam/chat/3"),
  ];
  assert.deepEqual(firstWordWaits(rows), [4000]);
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
