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

/** Reads the rows of the head-to-head eval. A row with no result counts as not graded for its pair. */
export function readHeadToHead(
  rows: readonly RecordedEvalResult[]
): HeadToHeadReading {
  const reading: HeadToHeadReading = { notGraded: [], results: [] };
  for (const row of rows) {
    const assertion = row.assertions.find(
      (candidate) => candidate.name === HEAD_TO_HEAD_LABEL
    );
    const metadata = assertion?.metadata ?? {};
    const a = textOf(metadata.a);
    const b = textOf(metadata.b);
    reading.rubric ??= textOf(metadata.rubric);
    const parsed = headToHeadItemSchema.safeParse(metadata.result);
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
  return reading;
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
 * run replaces an earlier one. Throws when the summary is missing or no longer
 * parses. Returns the new summary.
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
