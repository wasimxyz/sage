// Review repro: runner.ts calls reportHeadToHead whatever runStandalone
// returned, so a pass that crashed or was stopped with Ctrl-C after one row
// still replaces the compared sweep's headToHead. These are the steps it runs
// (readHeadToHead -> headToHeadSummaryOf -> mergeHeadToHead) on the one row a
// stopped pass left. The result looks complete: nothing says 3 items never ran.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sweepSummaryFileName } from "../agent/evals/lib/schema.ts";
import {
  FIXTURE_SWEEP_ID,
  rankingOf,
  reportItemOf,
  SETUP_A,
  SETUP_B,
  setupReportOf,
  sweepSummaryOf,
  writeSweepFiles,
} from "../agent/evals/lib/sweep-fixtures.ts";
import {
  headToHeadPreflight,
  headToHeadSummaryOf,
  mergeHeadToHead,
  readHeadToHead,
} from "../agent/scripts/eval/head-to-head-run.ts";

test("a head-to-head pass stopped after one of four items replaces the earlier result with a 1-item tally", (t) => {
  const root = mkdtempSync(join(tmpdir(), "h2h-partial-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const reportsDir = join(root, "reports");
  const ids = ["rent-panic", "dark-night", "good-day", "rent-panic-2"];
  const items = ids.map((id) => reportItemOf({ itemId: `sam/opener/${id}` }));
  writeSweepFiles(reportsDir, sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]), [
    setupReportOf({ items, setupId: SETUP_A }),
    setupReportOf({ items, setupId: SETUP_B }),
  ]);
  const preflight = headToHeadPreflight(FIXTURE_SWEEP_ID, 2, { reportsDir });
  assert.equal(preflight.plan.pairs[0]?.items.length, 4);

  // An earlier, complete run: A won all four.
  const fullRows = ids.map((id) => rowFor(`sam/opener/${id}`, "a"));
  mergeHeadToHead(
    reportsDir,
    FIXTURE_SWEEP_ID,
    headToHeadSummaryOf({ costUsd: 1, judgeModel: "j", reading: readHeadToHead(fullRows), setups: preflight.plan.setups, sweepId: "run-1" })
  );

  // A second run stopped after one row (crash or Ctrl-C). The runner still merges.
  const partialRows = [rowFor("sam/opener/rent-panic", "b")];
  mergeHeadToHead(
    reportsDir,
    FIXTURE_SWEEP_ID,
    headToHeadSummaryOf({ costUsd: 0.1, judgeModel: "j", reading: readHeadToHead(partialRows), setups: preflight.plan.setups, sweepId: "run-2" })
  );
  const saved = JSON.parse(readFileSync(join(reportsDir, sweepSummaryFileName(FIXTURE_SWEEP_ID)), "utf8"));
  const pair = saved.headToHead.pairs[0];
  assert.deepEqual(
    { bWinRate: pair.bWinRate, graded: pair.graded, notGraded: pair.notGraded, sweepId: saved.headToHead.sweepId },
    { bWinRate: 1, graded: 1, notGraded: 0, sweepId: "run-2" }
  );
  assert.fail("The partial run replaced the complete one, and reads B 100%, with 0 not graded and 3 items unaccounted for.");
});

function rowFor(itemId: string, winner: "a" | "b") {
  return {
    assertions: [
      {
        metadata: {
          a: SETUP_A,
          b: SETUP_B,
          pair: `${SETUP_A}-${SETUP_B}`,
          result: {
            itemId,
            kind: "opener",
            orders: [
              { first: "a", reason: "r", winner },
              { first: "b", reason: "r", winner },
            ],
            person: "sam",
            repeat: 1,
            split: false,
            winner,
          },
          rubric: "abc",
        },
        name: "soft:head-to-head",
        score: winner === "a" ? 1 : 0,
        severity: "soft",
      },
    ],
    completedAt: "",
    id: itemId,
    metadata: { itemId },
    startedAt: "",
    verdict: "passed",
  };
}
