import assert from "node:assert/strict";
import test from "node:test";

import { checkLabel, checkTier } from "./check-info.ts";
import { parseSetupReport, parseSweepSummary } from "./sweep-parse.ts";
import { sampleFiles, sampleSetupIds, sampleSweepId } from "./sweep-samples.ts";
import type { ParseOutcome, SetupReport } from "./sweep-types.ts";
import {
  compareSweepsNewestFirst,
  decodeParam,
  failedCheckCount,
  rankingRows,
  setupHref,
  setupLabel,
  sweepDateIso,
  sweepHref,
  varyingDimensions,
} from "./sweep-view.ts";

const setup = {
  chatModel: "qwen3:14b",
  contextLength: 32_768,
  dreamPrompt: "baseline",
  embedModel: "nomic-embed-text",
  memory: "off",
  prompt: "companion-v1",
  summaryModel: "qwen3.5:9b",
  thinking: "off",
};

test("varyingDimensions lists the axes with more than one value", () => {
  assert.deepEqual(
    varyingDimensions({
      chatModel: ["a", "b"],
      memory: ["off"],
      prompt: ["baseline", "companion-v1"],
      thinking: ["off", "on"],
    }),
    ["chatModel", "prompt", "thinking"]
  );
});

test("varyingDimensions falls back to the chat model and prompt", () => {
  assert.deepEqual(varyingDimensions({ chatModel: ["a"] }), [
    "chatModel",
    "prompt",
  ]);
  assert.deepEqual(varyingDimensions({}), ["chatModel", "prompt"]);
});

test("setupLabel names only the dimensions it is given", () => {
  assert.equal(setupLabel(setup), "qwen3:14b · companion-v1");
  assert.equal(
    setupLabel(setup, ["chatModel", "thinking", "memory", "contextLength"]),
    "qwen3:14b · thinking off · memory off · context 32768"
  );
});

test("sweepDateIso reads the date at the start of the sweep id", () => {
  assert.equal(sweepDateIso("2026-11-09-screen"), "2026-11-09T00:00:00Z");
  assert.equal(
    sweepDateIso("2026-11-09T0612-screen", "2026-11-10T01:00:00.000Z"),
    "2026-11-09T00:00:00Z"
  );
});

test("sweepDateIso uses the file time when the id has no date", () => {
  assert.equal(
    sweepDateIso("nightly", "2026-11-10T01:00:00.000Z"),
    "2026-11-10T01:00:00.000Z"
  );
  assert.equal(
    sweepDateIso("2026-13-45-screen", "2026-11-10T01:00:00.000Z"),
    "2026-11-10T01:00:00.000Z"
  );
  assert.equal(sweepDateIso("nightly"), undefined);
  assert.equal(sweepDateIso("nightly", "not a date"), undefined);
});

test("compareSweepsNewestFirst puts dated sweeps first, newest on top", () => {
  const sorted = [
    { id: "b" },
    { date: "2026-11-08T00:00:00Z", id: "old" },
    { date: "2026-11-09T00:00:00Z", id: "a-new" },
    { date: "2026-11-09T00:00:00Z", id: "b-new" },
    { id: "a" },
  ].sort(compareSweepsNewestFirst);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["b-new", "a-new", "old", "b", "a"]
  );
});

function parsedSample(): {
  reports: Map<string, ParseOutcome<SetupReport>>;
  summary: ReturnType<typeof parseSweepSummary>;
} {
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
  if (summary === undefined) {
    throw new Error("The samples have no sweep summary.");
  }
  return { reports, summary };
}

test("rankingRows keeps the runner's order and names each setup", () => {
  const { reports, summary } = parsedSample();
  assert.equal(summary.kind, "ok");
  if (summary.kind !== "ok") {
    return;
  }
  const rows = rankingRows(summary.value, reports);
  assert.deepEqual(
    rows.map((row) => [row.rank, row.entry.setupId, row.label, row.state]),
    [
      [1, sampleSetupIds.best, "qwen3:14b · companion-v1", "ok"],
      [2, sampleSetupIds.steady, "qwen3.5:9b · baseline", "ok"],
      [3, sampleSetupIds.slow, "gpt-oss:20b · companion-v1", "ok"],
    ]
  );
  assert.equal(rows[0]?.p90Ms, 9100);
  assert.equal(rows[2]?.p90Ms, 41_000);
});

test("rankingRows falls back to the setup id when a report is missing", () => {
  const { reports, summary } = parsedSample();
  assert.equal(summary.kind, "ok");
  if (summary.kind !== "ok") {
    return;
  }
  reports.delete(sampleSetupIds.steady);
  reports.set(sampleSetupIds.slow, {
    kind: "unsupported",
    message: "This report has schema version 2.",
  });
  const rows = rankingRows(summary.value, reports);
  assert.equal(rows[1]?.label, sampleSetupIds.steady);
  assert.equal(rows[1]?.state, "missing");
  assert.equal(rows[1]?.p90Ms, null);
  assert.equal(rows[2]?.label, sampleSetupIds.slow);
  assert.equal(rows[2]?.state, "unsupported");
  assert.equal(rows[0]?.state, "ok");
});

test("sample reports belong to the sample sweep", () => {
  const { reports } = parsedSample();
  assert.equal(reports.size, 3);
  for (const outcome of reports.values()) {
    assert.equal(outcome.kind === "ok" && outcome.value.sweepId, sampleSweepId);
  }
});

test("checkTier and checkLabel know the schema's ids and pass others through", () => {
  assert.equal(checkTier("crisis-handled"), "hard");
  assert.equal(checkTier("fast-enough"), "hard");
  assert.equal(checkTier("retrieval-top-hit"), "counted");
  assert.equal(checkTier("many-questions"), "slip");
  assert.equal(checkTier("needless-search"), "search");
  assert.equal(checkTier("warmth"), "rubric");
  assert.equal(checkTier("something-new"), "other");
  assert.equal(checkLabel("no-overreach"), "No overreach or false claims");
  assert.equal(checkLabel("something-new"), "something-new");
  assert.equal(checkTier("constructor"), "other");
  assert.equal(checkLabel("toString"), "toString");
});

test("links encode the ids and the params decode them again", () => {
  assert.equal(sweepHref("2026-11-09-screen"), "/sweeps/2026-11-09-screen");
  assert.equal(sweepHref("a b/c"), "/sweeps/a%20b%2Fc");
  assert.equal(
    setupHref("2026-11-09-screen", "3f9a1c7b2e"),
    "/sweeps/2026-11-09-screen/setups/3f9a1c7b2e"
  );
  assert.equal(decodeParam("a%20b%2Fc"), "a b/c");
  assert.equal(decodeParam("100%"), "100%");
});

test("failedCheckCount counts item checks and turn checks", () => {
  const report = parsedSample().reports.get(sampleSetupIds.best);
  assert.equal(report?.kind, "ok");
  if (report?.kind !== "ok") {
    return;
  }
  assert.deepEqual(report.value.items.map(failedCheckCount), [0, 1, 0]);
});
