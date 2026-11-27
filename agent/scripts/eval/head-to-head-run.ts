// The head-to-head sweep, from the runner's side.
//
// `tests: [head-to-head]` with `compare: <sweep id>` (or `--compare <sweep id>`)
// runs `grade/head-to-head` alone: no Sage, no setups. The eval compares the
// top 2 or 3 setups of the finished sweep, two at a time, in both orders. This
// file works out what it will compare (for the estimate and the questions the
// runner asks first), reads the rows the eval recorded, and adds the result to
// the `headToHead` field of the compared sweep's `.sweep.json`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildHeadToHeadSummary,
  callCount,
  HEAD_TO_HEAD_CHECK_ID,
  type HeadToHeadPlan,
  type PairResult,
  planHeadToHead,
} from "../../evals/lib/head-to-head.ts";
import type { RecordedEvalResult } from "../../evals/lib/recorder.ts";
import {
  type HeadToHeadItem,
  type HeadToHeadSummary,
  headToHeadItemSchema,
  parseSweepSummary,
  REPORT_SCHEMA_VERSION,
  type SweepSummary,
  sweepSummaryFileName,
} from "../../evals/lib/schema.ts";
import {
  loadSweepSource,
  type SweepDirs,
} from "../../evals/lib/sweep-source.ts";

/** The label the eval records its score under. */
export const HEAD_TO_HEAD_LABEL = `soft:${HEAD_TO_HEAD_CHECK_ID}`;

export interface HeadToHeadPreflight {
  calls: number;
  plan: HeadToHeadPlan;
}

/** Reads the compared sweep and says what would be compared. Throws a readable error when nothing can be. */
export function headToHeadPreflight(
  compare: string,
  top: number,
  dirs: SweepDirs
): HeadToHeadPreflight {
  const source = loadSweepSource(compare, dirs);
  const plan = planHeadToHead(source, top);
  return { calls: callCount(plan), plan };
}

/** One line per pair for the questions the runner asks before it spends anything. */
export function describePlan(plan: HeadToHeadPlan): string[] {
  return [
    `Comparing the top ${plan.setups.length} setups: ${plan.setups.join(", ")}`,
    ...plan.pairs.map(
      (pair) =>
        `  ${pair.a} vs ${pair.b}: ${pair.items.length} shared item${pair.items.length === 1 ? "" : "s"}`
    ),
  ];
}

export interface HeadToHeadReading {
  /** Items the judge could not answer, with why. */
  notGraded: { id: string; reason: string }[];
  results: PairResult[];
  /** The judge rubric hash, when a row carries it. */
  rubric?: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One item of one pair, the way the plan and the eval's rows both name it. */
function itemKey(pair: string, itemId: string, repeat: number): string {
  return `${pair}\u0000${itemId}\u0000${repeat}`;
}

/** The pair and item a row is for, when it says. */
function keyOfRow(
  row: RecordedEvalResult,
  pair: { a?: string; b?: string; result?: HeadToHeadItem }
): string | undefined {
  const { a, b, result } = pair;
  const pairName =
    a !== undefined && b !== undefined
      ? `${a}-${b}`
      : textOf(row.metadata.pair);
  const itemId = result?.itemId ?? textOf(row.metadata.itemId);
  if (pairName === undefined || itemId === undefined) {
    return undefined;
  }
  const { repeat } = row.metadata;
  return itemKey(
    pairName,
    itemId,
    result?.repeat ?? (typeof repeat === "number" ? repeat : 1)
  );
}

/**
 * Reads the rows of the head-to-head eval. A row with no result counts as not
 * graded for its pair. With the plan, so does an item the plan has and no row
 * has, such as one a stopped or crashed pass never reached. The tally then
 * says how many items never ran instead of reading as complete.
 */
export function readHeadToHead(
  rows: readonly RecordedEvalResult[],
  plan?: HeadToHeadPlan
): HeadToHeadReading {
  const reading: HeadToHeadReading = { notGraded: [], results: [] };
  const seen = new Set<string | undefined>();
  for (const row of rows) {
    const assertion = row.assertions.find(
      (candidate) => candidate.name === HEAD_TO_HEAD_LABEL
    );
    const metadata = assertion?.metadata ?? {};
    const a = textOf(metadata.a);
    const b = textOf(metadata.b);
    reading.rubric ??= textOf(metadata.rubric);
    const parsed = headToHeadItemSchema.safeParse(metadata.result);
    seen.add(
      keyOfRow(row, { a, b, result: parsed.success ? parsed.data : undefined })
    );
    if (a === undefined || b === undefined) {
      reading.notGraded.push({
        id: row.id,
        reason: row.error ?? row.skipReason ?? "The eval recorded no pair.",
      });
      continue;
    }
    if (
      assertion !== undefined &&
      metadata.notGraded !== true &&
      parsed.success
    ) {
      reading.results.push({ a, b, item: parsed.data });
      continue;
    }
    reading.results.push({ a, b, item: null });
    reading.notGraded.push({
      id: row.id,
      reason:
        textOf(metadata.reason) ??
        assertion?.message ??
        row.error ??
        "The eval recorded no result.",
    });
  }
  addUnreached(reading, seen, plan);
  return reading;
}

/** Counts each planned item that no row named as not graded for its pair. */
function addUnreached(
  reading: HeadToHeadReading,
  seen: ReadonlySet<string | undefined>,
  plan: HeadToHeadPlan | undefined
): void {
  for (const pair of plan?.pairs ?? []) {
    for (const item of pair.items) {
      if (!seen.has(itemKey(`${pair.a}-${pair.b}`, item.itemId, item.repeat))) {
        reading.results.push({ a: pair.a, b: pair.b, item: null });
        reading.notGraded.push({
          id: item.itemId,
          reason: "The pass recorded no row for this item.",
        });
      }
    }
  }
}

export interface HeadToHeadSummaryInput {
  costUsd: number;
  judgeModel: string;
  reading: HeadToHeadReading;
  setups: readonly string[];
  /** The id of the run that compared them. */
  sweepId: string;
}

export function headToHeadSummaryOf(
  input: HeadToHeadSummaryInput,
  now = new Date()
): HeadToHeadSummary {
  return buildHeadToHeadSummary({
    costUsd: input.costUsd,
    generatedAt: now.toISOString(),
    judge: { model: input.judgeModel },
    results: input.reading.results,
    rubric: input.reading.rubric,
    setups: input.setups,
    sweepId: input.sweepId,
  });
}

/**
 * Adds the result to the compared sweep's summary and writes it back. A later
 * run replaces an earlier one, so the runner calls this only for a pass that
 * finished. Throws when the summary is missing or no longer parses. Returns
 * the new summary.
 */
export function mergeHeadToHead(
  reportsDir: string,
  compare: string,
  result: HeadToHeadSummary
): { path: string; summary: SweepSummary } {
  const path = join(reportsDir, sweepSummaryFileName(compare));
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const current = parseSweepSummary(raw, path);
  const summary = parseSweepSummary(
    {
      ...current,
      headToHead: result,
      schemaVersion: REPORT_SCHEMA_VERSION,
    },
    path
  );
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  return { path, summary };
}
