import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  appendHumanGrade,
  type CalibrationItem,
  calibrationItemSchema,
  GRADES_FILE,
  parseCalibrationReport,
  parseHumanGrade,
  sampleFileName,
} from "../../evals/lib/calibration.ts";
import { costUsd } from "../../evals/lib/prices.ts";
import type { RecordedEvalResult } from "../../evals/lib/recorder.ts";
import {
  type HeadToHeadItem,
  parseSweepSummary,
  type SweepSummary,
} from "../../evals/lib/schema.ts";
import {
  FIXTURE_SWEEP_ID,
  rankingOf,
  reportItemOf,
  SETUP_A,
  SETUP_B,
  setupReportOf,
  sweepSummaryOf,
  writeSweepFiles,
} from "../../evals/lib/sweep-fixtures.ts";
import {
  calibrationInputs,
  calibrationReportOf,
  readCalibration,
  writeCalibrationReport,
} from "./calibration-run.ts";
import { ESTIMATE_TOKENS } from "./estimate.ts";
import {
  describePlan,
  headToHeadPreflight,
  headToHeadSummaryOf,
  mergeHeadToHead,
  readHeadToHead,
} from "./head-to-head-run.ts";
import type { PassOutcome } from "./passes.ts";
import {
  estimateCalibration,
  estimateHeadToHead,
  estimateJudgeCheck,
  runStandalone,
  STANDALONE_ESTIMATE,
  type StandaloneRun,
  standaloneFiles,
  unwrittenReason,
} from "./standalone.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern4 = /results could not be read/u;
const pattern3 = /^Estimate: about \d+ minutes and \$\d+\.\d\d$/u;
const pattern2 = /ENOENT/u;
const pattern1 = /No finished sweep/u;

const noSamplePattern = /No calibration sample in/u;
const notGradedYetPattern = /You have not graded any reply of sweep-1/u;
const crashedPattern = /The calibration pass crashed \(exit 3\)/u;
const stoppedPattern = /was stopped.*Nothing was written/u;
const unfinishedPattern = /did not finish cleanly.*Nothing was written/u;

const PRICE = { inputPerM: 2, outputPerM: 10 };

function row(
  itemId: string,
  assertions: RecordedEvalResult["assertions"],
  extra: Partial<RecordedEvalResult> = {}
): RecordedEvalResult {
  return {
    assertions,
    completedAt: "2026-11-15T10:00:00.000Z",
    id: itemId,
    metadata: { itemId },
    startedAt: "2026-11-15T10:00:00.000Z",
    verdict: "passed",
    ...extra,
  };
}

function assertion(
  name: string,
  metadata: Record<string, unknown>,
  extra: Partial<RecordedEvalResult["assertions"][number]> = {}
): RecordedEvalResult["assertions"][number] {
  return { metadata, name, score: 1, severity: "soft", ...extra };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function runFor(
  dir: string,
  overrides: Partial<StandaloneRun> = {}
): StandaloneRun {
  return {
    agentDir: join(dir, "agent"),
    credentials: { AI_GATEWAY_API_KEY: "gateway-key-0123456789" },
    filters: ["--tag", "opener"],
    name: "calibration",
    prefixes: ["calibration/agreement"],
    runDir: join(dir, "run"),
    stubUrl: "http://127.0.0.1:4242",
    sweepFile: join(dir, "run", "sweep.json"),
    sweepId: "2026-11-15T100000Z-calibration",
    ...overrides,
  };
}

test("the pass runs the evals against the stub target, with the key, and with no person or setup", async (t) => {
  const dir = tempDir(t);
  const seen: { command: unknown; env: Record<string, string> }[] = [];
  const result = await runStandalone(runFor(dir), {
    base: {
      PATH: "/usr/bin",
      SAGE_DATA_DIR: "/stray/data",
      SAGE_EVAL_PERSON: "sam",
      SAGE_EVAL_SETUP_ID: "0123456789",
      SAGE_EVAL_TRANSCRIPTS: "/stray/transcripts.jsonl",
    },
    runPass: (command, options) => {
      seen.push({ command, env: options.env });
      writeFileSync(
        options.env.SAGE_EVAL_RESULTS as string,
        `${JSON.stringify(row("one", []))}\n`
      );
      return Promise.resolve({
        code: 0,
        durationMs: 5,
        status: "ok",
      } satisfies PassOutcome);
    },
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.rows.length, 1);
  const [call] = seen;
  assert.deepEqual(call?.command, {
    agentDir: join(dir, "agent"),
    concurrency: 4,
    filters: ["--tag", "opener"],
    prefixes: ["calibration/agreement"],
    url: "http://127.0.0.1:4242",
  });
  const env = call?.env ?? {};
  assert.equal(env.AI_GATEWAY_API_KEY, "gateway-key-0123456789");
  assert.equal(env.SAGE_EVAL_RUN_DIR, join(dir, "run"));
  assert.equal(env.SAGE_EVAL_SWEEP_FILE, join(dir, "run", "sweep.json"));
  assert.equal(env.SAGE_EVAL_SWEEP_ID, "2026-11-15T100000Z-calibration");
  assert.equal(
    env.SAGE_EVAL_RESULTS,
    standaloneFiles(join(dir, "run"), "calibration").results
  );
  for (const name of [
    "SAGE_DATA_DIR",
    "SAGE_EVAL_PERSON",
    "SAGE_EVAL_SETUP_ID",
    "SAGE_EVAL_TRANSCRIPTS",
  ]) {
    assert.equal(env[name], undefined, name);
  }
});

test("a leftover results file is deleted first, so a rerun never counts a row twice", async (t) => {
  const dir = tempDir(t);
  const files = standaloneFiles(join(dir, "run"), "head-to-head");
  mkdirSync(files.dir, { recursive: true });
  writeFileSync(files.results, `${JSON.stringify(row("old", []))}\n`);
  const result = await runStandalone(runFor(dir, { name: "head-to-head" }), {
    runPass: () => Promise.resolve({ code: 0, durationMs: 1, status: "ok" }),
  });
  assert.deepEqual(result.rows, []);
});

test("a pass that crashes comes back with a problem, and the rows it did write", async (t) => {
  const dir = tempDir(t);
  const result = await runStandalone(runFor(dir), {
    runPass: (_command, options) => {
      writeFileSync(
        options.env.SAGE_EVAL_RESULTS as string,
        `${JSON.stringify(row("one", []))}\n`
      );
      return Promise.resolve({ code: 3, durationMs: 1, status: "crashed" });
    },
  });
  assert.match(result.problems.join(" "), crashedPattern);
  assert.equal(result.rows.length, 1);
});

test("an unreadable results file is a problem and not a throw", async (t) => {
  const dir = tempDir(t);
  const result = await runStandalone(runFor(dir), {
    runPass: (_command, options) => {
      writeFileSync(options.env.SAGE_EVAL_RESULTS as string, "not json\n");
      return Promise.resolve({ code: 0, durationMs: 1, status: "ok" });
    },
  });
  assert.match(result.problems.join(" "), pattern4);
  assert.deepEqual(result.rows, []);
});

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

test("a calibration costs one reply grade for each reply you graded", () => {
  const estimate = estimateCalibration(40, PRICE);
  assert.equal(estimate.calls, 40);
  assert.ok(
    Math.abs(
      estimate.costUsd - 40 * costUsd(PRICE, ESTIMATE_TOKENS.replyJudge)
    ) < 1e-9
  );
  assert.ok(
    Math.abs(
      estimate.hours - (40 * STANDALONE_ESTIMATE.secondsPerCall) / 4 / 3600
    ) < 1e-9
  );
  assert.match(estimate.lines[0] ?? "", pattern3);
  assert.ok(estimate.lines[1]?.includes("40 judge calls"));
  assert.ok(estimateCalibration(1, PRICE).lines[1]?.includes("1 judge call:"));
});

test("a head-to-head costs its calls at the comparison's size, and the judge check adds its items", () => {
  const estimate = estimateHeadToHead(10, PRICE);
  assert.ok(
    Math.abs(
      estimate.costUsd -
        10 * costUsd(PRICE, STANDALONE_ESTIMATE.headToHeadTokens)
    ) < 1e-9
  );
  const check = estimateJudgeCheck(
    { conversationItems: 2, dreamItems: 3, replyItems: 5 },
    PRICE
  );
  assert.ok(
    Math.abs(
      check -
        (3 * costUsd(PRICE, ESTIMATE_TOKENS.dreamSourceJudge) +
          5 * costUsd(PRICE, ESTIMATE_TOKENS.replyJudge) +
          2 * costUsd(PRICE, ESTIMATE_TOKENS.conversationJudge))
    ) < 1e-9
  );
});

// ---------------------------------------------------------------------------
// Calibration, from the runner's side
// ---------------------------------------------------------------------------

function sampleItem(id: string): CalibrationItem {
  return calibrationItemSchema.parse({
    checks: ["journal-right"],
    expect: "venting",
    id,
    itemId: "sam/opener/rent-panic",
    kind: "opener",
    message: "m",
    person: "sam",
    reply: "r",
    rubric: ["warmth"],
    setupId: SETUP_A,
  });
}

function writeSample(dir: string, ids: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, sampleFileName("sweep-1")),
    JSON.stringify({ items: ids.map(sampleItem), sampleId: "sweep-1" })
  );
}

function grade(dir: string, id: string): void {
  appendHumanGrade(
    join(dir, GRADES_FILE),
    parseHumanGrade({
      checks: { "journal-right": true },
      grader: "human",
      id,
      rubric: { warmth: 4 },
      sampleId: "sweep-1",
    })
  );
}

test("the inputs are the samples and the grades you gave them, and a missing piece stops the run before it spends anything", (t) => {
  const dir = tempDir(t);
  assert.throws(() => calibrationInputs(undefined, dir), noSamplePattern);
  writeSample(dir, ["a", "b", "c"]);
  assert.throws(() => calibrationInputs("sweep-1", dir), notGradedYetPattern);
  grade(dir, "a");
  grade(dir, "c");
  assert.deepEqual(calibrationInputs(undefined, dir), {
    graded: 2,
    sampled: 3,
    samples: ["sweep-1"],
  });
});

function comparisonRow(id: string, human: boolean, judge: boolean) {
  return row(
    "sam/opener/rent-panic",
    [
      assertion("soft:calibration", {
        calibrationId: id,
        comparison: {
          checks: { "journal-right": { human, judge } },
          id,
          rubric: { warmth: { human: 4, judge: 3 } },
          sampleId: "sweep-1",
        },
        rubric: "abcdef0123",
        sampleId: "sweep-1",
      }),
    ],
    { metadata: { itemId: "sam/opener/rent-panic" } }
  );
}

test("the rows of the agreement eval become comparisons, and a row with none counts as not graded", () => {
  const reading = readCalibration([
    comparisonRow("a", true, true),
    comparisonRow("b", false, true),
    row("sam/opener/rent-panic", [
      assertion("soft:calibration", {
        calibrationId: "c",
        notGraded: true,
        reason: "not graded: spending cap",
      }),
    ]),
    row("sam/opener/rent-panic", [], { error: "boom", verdict: "failed" }),
  ]);
  assert.equal(reading.comparisons.length, 2);
  assert.equal(reading.rubric, "abcdef0123");
  assert.deepEqual(reading.notGraded, [
    { id: "c", reason: "not graded: spending cap" },
    { id: "sam/opener/rent-panic", reason: "boom" },
  ]);
});

test("the report is written as <sweep id>.calibration.json and reads back", (t) => {
  const dir = tempDir(t);
  const report = calibrationReportOf(
    {
      costUsd: 0.3,
      humanGraded: 2,
      judgeModel: "acme/judge-1",
      reading: readCalibration([
        comparisonRow("a", true, true),
        comparisonRow("b", false, true),
      ]),
      samples: ["sweep-1"],
      sweepId: "2026-11-15T100000Z-calibration",
    },
    new Date("2026-11-15T10:00:00Z")
  );
  assert.equal(report.items.notGraded, 0);
  assert.equal(report.generatedAt, "2026-11-15T10:00:00.000Z");
  const path = writeCalibrationReport(join(dir, "reports"), report);
  assert.equal(
    path,
    join(dir, "reports", "2026-11-15T100000Z-calibration.calibration.json")
  );
  assert.deepEqual(
    parseCalibrationReport(JSON.parse(readFileSync(path, "utf8"))),
    report
  );
  assert.equal(report.checks[0]?.misses, 1);
  assert.equal(report.rubricAgreement[0]?.within1, 1);
});

// ---------------------------------------------------------------------------
// Head-to-head, from the runner's side
// ---------------------------------------------------------------------------

function itemOf(winner: "a" | "b" | "tie"): HeadToHeadItem {
  return {
    itemId: "sam/opener/rent-panic",
    kind: "opener",
    orders: [
      { first: "a", reason: "x", winner },
      { first: "b", reason: "y", winner },
    ],
    person: "sam",
    repeat: 1,
    split: false,
    winner,
  };
}

function pairRow(
  result: HeadToHeadItem | null,
  extra: Record<string, unknown> = {}
) {
  return row("sam/opener/rent-panic", [
    assertion("soft:head-to-head", {
      a: SETUP_A,
      b: SETUP_B,
      rubric: "abcdef0123",
      ...(result === null
        ? { notGraded: true, reason: "not graded: cap" }
        : { result }),
      ...extra,
    }),
  ]);
}

test("the rows of the head-to-head eval become results by pair, and one the judge could not answer is kept as not graded", () => {
  const reading = readHeadToHead([
    pairRow(itemOf("a")),
    pairRow(itemOf("tie")),
    pairRow(null),
    row("sam/opener/rent-panic", [], { error: "boom", verdict: "failed" }),
  ]);
  assert.equal(reading.rubric, "abcdef0123");
  assert.deepEqual(
    reading.results.map((result) => result.item?.winner ?? null),
    ["a", "tie", null]
  );
  assert.deepEqual(
    reading.notGraded.map((entry) => entry.reason),
    ["not graded: cap", "boom"]
  );
});

function finishedSweepDir(t: test.TestContext): string {
  const reportsDir = tempDir(t);
  writeSweepFiles(
    reportsDir,
    sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]),
    [
      setupReportOf({ items: [reportItemOf()], setupId: SETUP_A }),
      setupReportOf({ items: [reportItemOf()], setupId: SETUP_B }),
    ]
  );
  return reportsDir;
}

test("the result is merged into the compared sweep's summary, and a later run replaces it", (t) => {
  const reportsDir = finishedSweepDir(t);
  const make = (winner: "a" | "b" | "tie", sweepId: string) =>
    headToHeadSummaryOf(
      {
        costUsd: 0.2,
        judgeModel: "acme/judge-1",
        reading: readHeadToHead([pairRow(itemOf(winner))]),
        setups: [SETUP_A, SETUP_B],
        sweepId,
      },
      new Date("2026-11-15T10:00:00Z")
    );
  const first = mergeHeadToHead(
    reportsDir,
    FIXTURE_SWEEP_ID,
    make("a", "run-1")
  );
  assert.equal(first.path, join(reportsDir, `${FIXTURE_SWEEP_ID}.sweep.json`));
  assert.equal(first.summary.headToHead?.sweepId, "run-1");
  assert.equal(first.summary.headToHead?.pairs[0]?.aWins, 1);
  assert.equal(first.summary.headToHead?.standings[0]?.setupId, SETUP_A);

  const second = mergeHeadToHead(
    reportsDir,
    FIXTURE_SWEEP_ID,
    make("b", "run-2")
  );
  assert.equal(second.summary.headToHead?.sweepId, "run-2");
  const onDisk: SweepSummary = parseSweepSummary(
    JSON.parse(readFileSync(second.path, "utf8"))
  );
  assert.equal(onDisk.headToHead?.pairs[0]?.bWins, 1);
  // The rest of the summary is as it was.
  assert.deepEqual(
    { ...onDisk, headToHead: undefined },
    {
      ...sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]),
      headToHead: undefined,
    }
  );
});

test("merging into a sweep that is not there is an error", (t) => {
  assert.throws(
    () =>
      mergeHeadToHead(
        tempDir(t),
        FIXTURE_SWEEP_ID,
        headToHeadSummaryOf({
          costUsd: 0,
          judgeModel: "x",
          reading: { notGraded: [], results: [] },
          setups: [SETUP_A, SETUP_B],
          sweepId: "run-1",
        })
      ),
    pattern2
  );
});

test("the preflight reads the finished sweep, counts the judge calls, and says what it will compare", (t) => {
  const reportsDir = finishedSweepDir(t);
  const preflight = headToHeadPreflight(FIXTURE_SWEEP_ID, 3, { reportsDir });
  assert.deepEqual(preflight.plan.setups, [SETUP_A, SETUP_B]);
  assert.equal(preflight.calls, 2, "one shared item, two orders");
  assert.deepEqual(describePlan(preflight.plan), [
    `Comparing the top 2 setups: ${SETUP_A}, ${SETUP_B}`,
    `  ${SETUP_A} vs ${SETUP_B}: 1 shared item`,
  ]);
  assert.throws(
    () => headToHeadPreflight("2026-01-01T000000Z-nope", 3, { reportsDir }),
    pattern1
  );
});

/** The row the head-to-head eval records for one item of the A and B pair. */
function winnerRow(itemId: string, winner: "a" | "b") {
  return row(
    itemId,
    [
      assertion("soft:head-to-head", {
        a: SETUP_A,
        b: SETUP_B,
        pair: `${SETUP_A}-${SETUP_B}`,
        result: { ...itemOf(winner), itemId },
        rubric: "abcdef0123",
      }),
    ],
    { metadata: { itemId, kind: "opener", repeat: 1, setupId: SETUP_A } }
  );
}

test("a head-to-head pass that stopped after one of four items counts the other three as not graded", (t) => {
  const reportsDir = tempDir(t);
  const ids = ["rent-panic", "dark-night", "good-day", "rent-panic-2"].map(
    (id) => `sam/opener/${id}`
  );
  const items = ids.map((itemId) => reportItemOf({ itemId }));
  writeSweepFiles(
    reportsDir,
    sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]),
    [
      setupReportOf({ items, setupId: SETUP_A }),
      setupReportOf({ items, setupId: SETUP_B }),
    ]
  );
  const { plan } = headToHeadPreflight(FIXTURE_SWEEP_ID, 2, { reportsDir });
  assert.equal(plan.pairs[0]?.items.length, 4);

  const stopped = readHeadToHead([winnerRow(ids[0] as string, "b")], plan);
  const { pairs } = headToHeadSummaryOf({
    costUsd: 0.1,
    judgeModel: "acme/judge-1",
    reading: stopped,
    setups: plan.setups,
    sweepId: "run-2",
  });
  assert.deepEqual(
    { graded: pairs[0]?.graded, notGraded: pairs[0]?.notGraded },
    { graded: 1, notGraded: 3 }
  );
  assert.deepEqual(
    stopped.notGraded.map((entry) => entry.id),
    ids.slice(1)
  );

  // A pass that ran to its end reads the same with or without the plan.
  const all = ids.map((id) => winnerRow(id, "a"));
  assert.deepEqual(readHeadToHead(all, plan), readHeadToHead(all));
  // A row the eval recorded as an error counts once, not again as missing.
  const failed = row(ids[1] as string, [], {
    error: "boom",
    metadata: { itemId: ids[1], pair: `${SETUP_A}-${SETUP_B}`, repeat: 1 },
    verdict: "failed",
  });
  const withError = readHeadToHead(
    [winnerRow(ids[0] as string, "a"), failed],
    plan
  );
  assert.deepEqual(
    withError.notGraded.map((entry) => entry.id),
    [ids[1], ids[2], ids[3]]
  );
});

test("a calibration pass counts a reply you graded that got no row as not graded", () => {
  const report = calibrationReportOf({
    costUsd: 0.1,
    humanGraded: 4,
    judgeModel: "acme/judge-1",
    reading: readCalibration([comparisonRow("a", true, true)]),
    samples: ["sweep-1"],
    sweepId: "2026-11-15T100000Z-calibration",
  });
  assert.deepEqual(
    { compared: report.items.compared, notGraded: report.items.notGraded },
    { compared: 1, notGraded: 3 }
  );
});

test("a pass that crashed or was stopped writes no result, and one that finished does", () => {
  assert.equal(unwrittenReason("head-to-head", { problems: [] }, false), null);
  assert.match(
    unwrittenReason("head-to-head", { problems: [] }, true) ?? "",
    stoppedPattern
  );
  assert.match(
    unwrittenReason(
      "calibration",
      { problems: ["The calibration pass crashed (exit 3)."] },
      false
    ) ?? "",
    unfinishedPattern
  );
});
