import assert from "node:assert/strict";
import test from "node:test";

import {
  headToHeadSummarySchema,
  parseSweepFile,
  parseSweepSummary,
  REPORT_SCHEMA_VERSION,
  reportItemSchema,
  reportTurnSchema,
  SchemaError,
} from "./schema.ts";
import {
  FIXTURE_SWEEP_ID,
  rankingOf,
  SETUP_A,
  SETUP_B,
  sweepSummaryOf,
} from "./sweep-fixtures.ts";

const pattern1 = /Unknown expect value/u;

const aloneCalibrationPattern = /calibration runs alone/u;
const aloneBothPattern = /calibration and head-to-head run alone/u;
const compareOnlyPattern = /only head-to-head and calibration read it/u;
const sweepIdPattern = /Use a sweep id/u;

function messages(input: unknown): string {
  try {
    parseSweepFile(input);
  } catch (error) {
    assert.ok(error instanceof SchemaError);
    return error.message;
  }
  assert.fail("expected the sweep file to be refused");
}

test("calibration and head-to-head run alone, with no Sage and no other test", () => {
  assert.deepEqual(parseSweepFile({ tests: ["calibration"] }).tests, [
    "calibration",
  ]);
  assert.deepEqual(parseSweepFile({ tests: ["head-to-head"] }).tests, [
    "head-to-head",
  ]);
  assert.match(
    messages({ tests: ["person", "calibration"] }),
    aloneCalibrationPattern
  );
  assert.match(
    messages({ tests: ["calibration", "head-to-head"] }),
    aloneBothPattern
  );
});

test("compare names a finished sweep, and only head-to-head and calibration read it", () => {
  const sweep = parseSweepFile({
    compare: FIXTURE_SWEEP_ID,
    tests: ["head-to-head"],
  });
  assert.equal(sweep.compare, FIXTURE_SWEEP_ID);
  assert.equal(parseSweepFile({ tests: ["calibration"] }).compare, undefined);
  assert.match(
    messages({ compare: FIXTURE_SWEEP_ID, tests: ["person"] }),
    compareOnlyPattern
  );
  assert.match(
    messages({ compare: "../elsewhere", tests: ["head-to-head"] }),
    sweepIdPattern
  );
});

test("head-to-head compares the top three setups by default, and two or three are allowed", () => {
  assert.equal(parseSweepFile({ tests: ["head-to-head"] }).compareTop, 3);
  assert.equal(
    parseSweepFile({ compareTop: 2, tests: ["head-to-head"] }).compareTop,
    2
  );
  for (const compareTop of [1, 4, 2.5]) {
    assert.throws(
      () => parseSweepFile({ compareTop, tests: ["head-to-head"] }),
      SchemaError
    );
  }
});

test("a sweep summary can carry the result of a head-to-head run", () => {
  const plain = sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]);
  assert.equal(plain.headToHead, undefined);
  const result = {
    costUsd: 0.4,
    generatedAt: "2026-11-15T10:00:00.000Z",
    judge: { model: "acme/judge-1" },
    pairs: [
      {
        a: SETUP_A,
        aWinRate: 0.5,
        aWins: 1,
        b: SETUP_B,
        bWinRate: 0,
        bWins: 0,
        graded: 2,
        items: [],
        notGraded: 0,
        splits: 1,
        tieRate: 0.5,
        ties: 1,
      },
    ],
    setups: [SETUP_A, SETUP_B],
    standings: [
      {
        graded: 2,
        losses: 0,
        setupId: SETUP_A,
        ties: 1,
        winRate: 0.5,
        wins: 1,
      },
      { graded: 2, losses: 1, setupId: SETUP_B, ties: 1, winRate: 0, wins: 0 },
    ],
    sweepId: "2026-11-15T100000Z-head-to-head",
  };
  assert.deepEqual(headToHeadSummarySchema.parse(result), result);
  const merged = parseSweepSummary({
    ...plain,
    headToHead: result,
    schemaVersion: REPORT_SCHEMA_VERSION,
  });
  assert.equal(merged.headToHead?.pairs[0]?.aWins, 1);
  assert.throws(
    () =>
      parseSweepSummary({
        ...plain,
        headToHead: { ...result, pairs: [{ ...result.pairs[0], extra: 1 }] },
      }),
    SchemaError
  );
});

test("a report item and each of its turns can say what they answer", () => {
  const item = reportItemSchema.parse({
    expect: "anger",
    itemId: "sam/conversation/wedding-costs",
    journal: "own",
    kind: "conversation",
    person: "sam",
    repeat: 1,
    status: "graded",
    turns: [
      { expect: "venting", role: "assistant", text: "Hello." },
      { role: "assistant", text: "No say." },
    ],
  });
  assert.equal(item.expect, "anger");
  assert.equal(item.turns[0]?.expect, "venting");
  assert.equal(item.turns[1]?.expect, undefined);
  assert.equal(
    reportItemSchema.parse({ ...item, expect: undefined }).expect,
    undefined
  );
  assert.throws(
    () =>
      reportTurnSchema.parse({ expect: "sulking", role: "user", text: "x" }),
    pattern1
  );
});
