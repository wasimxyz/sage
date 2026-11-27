import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reportFileName, type TranscriptRow } from "./schema.ts";
import {
  FIXTURE_SWEEP_ID,
  rankingOf,
  reportItemOf,
  SETUP_A,
  SETUP_B,
  setupReportOf,
  sweepSummaryOf,
  writeSweepFiles,
} from "./sweep-fixtures.ts";
import {
  loadSetupReport,
  loadSweepSource,
  loadSweepSummary,
  loadTranscriptIndex,
  reportSetupIds,
  rowKey,
  rowOfReportItem,
  sourceRow,
  transcriptsPathOf,
} from "./sweep-source.ts";

const notFinishedPattern = /No finished sweep 2026-01-01T000000Z-nope/u;
const noReportPattern = /has no report/u;
const notJsonPattern = /is not valid JSON/u;

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-source-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function writeFinished(reportsDir: string): void {
  writeSweepFiles(
    reportsDir,
    sweepSummaryOf([rankingOf(SETUP_B), rankingOf(SETUP_A)]),
    [
      setupReportOf({ items: [reportItemOf()], setupId: SETUP_A }),
      setupReportOf({ items: [reportItemOf()], setupId: SETUP_B }),
    ]
  );
}

test("a report item becomes the transcript row of the pass that made it", () => {
  const item = reportItemOf({
    ended: "max-turns",
    flags: ["refused"],
    itemId: "sam/conversation/wedding-costs",
    kind: "conversation",
    turns: [
      ["First.", "Reply one."],
      ["Second.", "Reply two."],
    ],
  });
  const row = rowOfReportItem(item, SETUP_A);
  assert.ok(row);
  assert.equal(row.setupId, SETUP_A);
  assert.equal(row.kind, "conversation");
  assert.equal(row.ended, "max-turns");
  assert.deepEqual(row.simulatedUserFlags, ["refused"]);
  assert.deepEqual(
    row.turns.map((turn) => [turn.role, turn.text]),
    [
      ["user", "First."],
      ["assistant", "Reply one."],
      ["user", "Second."],
      ["assistant", "Reply two."],
    ]
  );
  // The checks and rubric stay in the report. The row is what the pass wrote.
  assert.equal("checks" in (row.turns[1] ?? {}), false);
});

test("an item that is not a reply has no row", () => {
  const fact = { ...reportItemOf(), kind: "fact" as const };
  assert.equal(rowOfReportItem(fact, SETUP_A), null);
});

test("a finished sweep is its summary and its reports, in ranking order", (t) => {
  const reportsDir = tempDir(t);
  writeFinished(reportsDir);
  const source = loadSweepSource(FIXTURE_SWEEP_ID, { reportsDir });
  assert.deepEqual(
    source.reports.map((report) => report.setupId),
    [SETUP_B, SETUP_A]
  );
  assert.equal(source.summary.sweepId, FIXTURE_SWEEP_ID);
  assert.equal(source.transcripts.size, 0, "no run folder was named");
  assert.deepEqual(reportSetupIds(FIXTURE_SWEEP_ID, reportsDir), [
    SETUP_A,
    SETUP_B,
  ]);
  assert.deepEqual(reportSetupIds("another-sweep", reportsDir), []);
});

test("a sweep that never finished, or a setup with no report, is a readable error", (t) => {
  const reportsDir = tempDir(t);
  writeFinished(reportsDir);
  assert.throws(
    () => loadSweepSummary("2026-01-01T000000Z-nope", reportsDir),
    notFinishedPattern
  );
  assert.throws(
    () => loadSetupReport(FIXTURE_SWEEP_ID, "ffffffffff", reportsDir),
    noReportPattern
  );
  writeFileSync(
    join(reportsDir, reportFileName(FIXTURE_SWEEP_ID, SETUP_A)),
    "{"
  );
  assert.throws(
    () => loadSetupReport(FIXTURE_SWEEP_ID, SETUP_A, reportsDir),
    notJsonPattern
  );
});

function transcriptRow(reply: string): TranscriptRow {
  return {
    ended: "done",
    itemId: "sam/opener/rent-panic",
    journal: "own",
    kind: "opener",
    person: "sam",
    repeat: 1,
    setupId: SETUP_A,
    simulatedUserFlags: [],
    turns: [
      { role: "user", stepModelIds: [], text: "Rent is due.", toolCalls: [] },
      { role: "assistant", stepModelIds: [], text: reply, toolCalls: [] },
    ],
  };
}

test("a transcript in the run folder wins over the report's own turns", (t) => {
  const dir = tempDir(t);
  const reportsDir = join(dir, "reports");
  const runsDir = join(dir, "runs");
  writeFinished(reportsDir);
  const path = transcriptsPathOf(
    join(runsDir, FIXTURE_SWEEP_ID),
    SETUP_A,
    "sam"
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(transcriptRow("From the transcript."))}\n`
  );

  const index = loadTranscriptIndex(join(runsDir, FIXTURE_SWEEP_ID));
  assert.deepEqual(
    [...index.keys()],
    [rowKey(SETUP_A, "sam/opener/rent-panic", 1)]
  );

  const source = loadSweepSource(FIXTURE_SWEEP_ID, { reportsDir, runsDir });
  const reportA = source.reports.find((report) => report.setupId === SETUP_A);
  const reportB = source.reports.find((report) => report.setupId === SETUP_B);
  assert.ok(reportA && reportB);
  const fromTranscript = sourceRow(source, SETUP_A, reportA.items[0] as never);
  assert.equal(fromTranscript?.turns[1]?.text, "From the transcript.");
  const fromReport = sourceRow(source, SETUP_B, reportB.items[0] as never);
  assert.equal(
    fromReport?.turns[1]?.text,
    "That sounds stressful. What is the gap, roughly?"
  );
});

test("a transcript row gets the judge's flags from the report, beside its own", () => {
  const item = reportItemOf({ flags: ["soft-after-crisis"] });
  const rows = new Map([
    [
      rowKey(SETUP_A, "sam/opener/rent-panic", 1),
      {
        ...transcriptRow("From the transcript."),
        simulatedUserFlags: ["refused" as const],
      },
    ],
  ]);
  const row = sourceRow({ transcripts: rows }, SETUP_A, item);
  assert.deepEqual(row?.simulatedUserFlags, ["refused", "soft-after-crisis"]);
  assert.equal(row?.turns[1]?.text, "From the transcript.");
  // The row the pass wrote is not changed.
  assert.deepEqual(
    rows.get(rowKey(SETUP_A, "sam/opener/rent-panic", 1))?.simulatedUserFlags,
    ["refused"]
  );
  // A flag both have counts once, and a report with no flags leaves the row as it is.
  assert.deepEqual(
    sourceRow(
      { transcripts: rows },
      SETUP_A,
      reportItemOf({ flags: ["refused"] })
    )?.simulatedUserFlags,
    ["refused"]
  );
  assert.equal(
    sourceRow({ transcripts: rows }, SETUP_A, reportItemOf()),
    rows.get(rowKey(SETUP_A, "sam/opener/rent-panic", 1))
  );
});

test("a run folder that is gone, or holds a bad file, leaves the reports to answer", (t) => {
  const dir = tempDir(t);
  assert.equal(loadTranscriptIndex(join(dir, "missing")).size, 0);
  const runDir = join(dir, "run");
  const path = transcriptsPathOf(runDir, SETUP_A, "sam");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "not json\n");
  assert.equal(loadTranscriptIndex(runDir).size, 0);
});
