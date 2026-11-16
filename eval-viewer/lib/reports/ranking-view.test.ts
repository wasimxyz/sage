import assert from "node:assert/strict";
import test from "node:test";

import { parseSetupReport, parseSweepSummary } from "./sweep-parse.ts";
import { sampleFiles, sampleSetupIds } from "./sweep-samples.ts";
import type { ParseOutcome, SetupReport } from "./sweep-types.ts";
import {
  compareHref,
  defaultRankingSort,
  dreamHref,
  itemHref,
  nextRankingSort,
  parseRankingSort,
  type RankingSortKey,
  rankingRows,
  rankingSortHref,
  type SortDirection,
  sortRankingRows,
} from "./sweep-view.ts";

function sampleRows() {
  const reports = new Map<string, ParseOutcome<SetupReport>>();
  let summary: ReturnType<typeof parseSweepSummary> | undefined;
  for (const [name, text] of Object.entries(sampleFiles())) {
    if (name.endsWith(".sweep.json")) {
      summary = parseSweepSummary(text);
      continue;
    }
    const outcome = parseSetupReport(text);
    if (outcome.kind === "ok") {
      reports.set(outcome.value.setupId, outcome);
    }
  }
  if (summary?.kind !== "ok") {
    throw new Error("The samples have no sweep summary.");
  }
  return { reports, rows: rankingRows(summary.value, reports), summary };
}

function idsOf(rows: { entry: { setupId: string } }[]): string[] {
  return rows.map((row) => row.entry.setupId);
}

test("rankingRows carries the named hard failures, swap growth, and cost", () => {
  const { rows } = sampleRows();
  assert.deepEqual(rows[0]?.hardFailures, []);
  assert.deepEqual(rows[2]?.hardFailures, [
    {
      count: 1,
      detail: "median 24 s is over the 20 s limit",
      id: "fast-enough",
    },
  ]);
  assert.equal(rows[0]?.swapGrowthMB, 12);
  assert.equal(rows[1]?.swapGrowthMB, 40);
  assert.equal(rows[0]?.costUsd, 1.2);
});

test("rankingRows names the failed hard checks even when the report is missing", () => {
  const { reports, summary } = sampleRows();
  reports.delete(sampleSetupIds.slow);
  if (summary.kind !== "ok") {
    return;
  }
  const [, , row] = rankingRows(summary.value, reports);
  assert.deepEqual(row?.hardFailures, [
    { count: 0, detail: "", id: "fast-enough" },
  ]);
  assert.equal(row?.costUsd, null);
  assert.equal(row?.swapGrowthMB, null);
});

test("sortRankingRows orders by a column and puts missing values last either way", () => {
  const { rows } = sampleRows();
  const ids = sampleSetupIds;
  const sorted = (key: RankingSortKey, dir: SortDirection) =>
    idsOf(sortRankingRows(rows, { dir, key }));

  assert.deepEqual(sorted("rank", "asc"), [ids.best, ids.steady, ids.slow]);
  assert.deepEqual(sorted("rank", "desc"), [ids.slow, ids.steady, ids.best]);
  assert.deepEqual(sorted("rubric", "desc"), [ids.slow, ids.best, ids.steady]);
  assert.deepEqual(sorted("counted", "asc"), [ids.slow, ids.best, ids.steady]);
  assert.deepEqual(sorted("median", "asc"), [ids.steady, ids.best, ids.slow]);
  assert.deepEqual(sorted("p90", "desc"), [ids.slow, ids.best, ids.steady]);
  assert.deepEqual(sorted("swap", "desc"), [ids.steady, ids.best, ids.slow]);
  assert.deepEqual(sorted("hard", "asc"), [ids.best, ids.steady, ids.slow]);
  assert.deepEqual(sorted("graded", "asc"), [ids.best, ids.steady, ids.slow]);
  assert.deepEqual(sorted("graded", "desc"), [ids.slow, ids.best, ids.steady]);
  // Only the best setup has a spread. The others stay last, in the runner's order.
  assert.deepEqual(sorted("spread", "asc"), [ids.best, ids.steady, ids.slow]);
  assert.deepEqual(sorted("spread", "desc"), [ids.best, ids.steady, ids.slow]);
});

test("sortRankingRows leaves its input alone", () => {
  const { rows } = sampleRows();
  const before = idsOf(rows);
  sortRankingRows(rows, { dir: "desc", key: "rank" });
  assert.deepEqual(idsOf(rows), before);
});

test("parseRankingSort reads the key and direction and falls back to the runner's order", () => {
  assert.deepEqual(parseRankingSort(undefined, undefined), defaultRankingSort);
  assert.deepEqual(parseRankingSort("nonsense", "desc"), defaultRankingSort);
  assert.deepEqual(parseRankingSort("rubric", undefined), {
    dir: "desc",
    key: "rubric",
  });
  assert.deepEqual(parseRankingSort("counted", undefined), {
    dir: "asc",
    key: "counted",
  });
  assert.deepEqual(parseRankingSort("rubric", "asc"), {
    dir: "asc",
    key: "rubric",
  });
  assert.deepEqual(parseRankingSort("rubric", "sideways"), {
    dir: "desc",
    key: "rubric",
  });
});

test("nextRankingSort starts a new column at its best side and flips the sorted one", () => {
  assert.deepEqual(nextRankingSort(defaultRankingSort, "rubric"), {
    dir: "desc",
    key: "rubric",
  });
  assert.deepEqual(nextRankingSort({ dir: "desc", key: "rubric" }, "rubric"), {
    dir: "asc",
    key: "rubric",
  });
  assert.deepEqual(nextRankingSort({ dir: "asc", key: "rubric" }, "rubric"), {
    dir: "desc",
    key: "rubric",
  });
  assert.deepEqual(nextRankingSort({ dir: "desc", key: "rubric" }, "cost"), {
    dir: "asc",
    key: "cost",
  });
});

test("rankingSortHref leaves the runner's order without a query", () => {
  assert.equal(rankingSortHref("s", defaultRankingSort), "/sweeps/s");
  assert.equal(
    rankingSortHref("s", { dir: "desc", key: "rubric" }),
    "/sweeps/s?dir=desc&sort=rubric"
  );
  assert.equal(
    rankingSortHref("s", { dir: "desc", key: "rank" }),
    "/sweeps/s?dir=desc&sort=rank"
  );
  assert.deepEqual(parseRankingSort("rank", "desc"), {
    dir: "desc",
    key: "rank",
  });
});

test("item, Dream, and compare links encode what they carry", () => {
  const item = { itemId: "engaged/opener/rent-panic", repeat: 2 };
  assert.equal(
    itemHref("2026-11-09-screen", "3f9a1c7b2e", item),
    "/sweeps/2026-11-09-screen/setups/3f9a1c7b2e/item?id=engaged%2Fopener%2Frent-panic&repeat=2"
  );
  assert.equal(
    dreamHref("2026-11-09-screen", "3f9a1c7b2e"),
    "/sweeps/2026-11-09-screen/setups/3f9a1c7b2e/dream"
  );
  assert.equal(
    dreamHref("2026-11-09-screen", "3f9a1c7b2e", "long history"),
    "/sweeps/2026-11-09-screen/setups/3f9a1c7b2e/dream?person=long+history"
  );
  assert.equal(
    dreamHref("s", "3f9a1c7b2e", undefined, true),
    "/sweeps/s/setups/3f9a1c7b2e/dream?claims=1"
  );
  assert.equal(
    dreamHref("s", "3f9a1c7b2e", "grief", true),
    "/sweeps/s/setups/3f9a1c7b2e/dream?person=grief&claims=1"
  );
  assert.equal(
    compareHref("s", "aaaaaaaaaa", "bbbbbbbbbb", {
      failing: "1",
      kind: undefined,
      person: "",
    }),
    "/sweeps/s/compare?a=aaaaaaaaaa&b=bbbbbbbbbb&failing=1"
  );
});
