// The calibration sweep, from the runner's side.
//
// `tests: [calibration]` runs `calibration/agreement` alone: no Sage, no
// setups, and no judge check, because the sweep measures the judge against your
// grades and a judge that fails the check should still show its numbers. The
// eval records one `soft:calibration` score for each reply you graded, with
// both sets of verdicts in its metadata. This file reads those rows and writes
// `agent/evals/reports/<sweep id>.calibration.json`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCalibrationReport,
  type CalibrationReport,
  calibrationReportFileName,
  defaultCalibrationDir,
  GRADES_FILE,
  gradedItems,
  type ItemComparison,
  itemComparisonSchema,
  loadCalibrationSamples,
  loadHumanGrades,
} from "../../evals/lib/calibration.ts";
import type { RecordedEvalResult } from "../../evals/lib/recorder.ts";

/** The label the eval records its score under. */
export const CALIBRATION_LABEL = "soft:calibration";

export interface CalibrationInputs {
  /** The replies you graded, which the judge will grade again. */
  graded: number;
  /** Replies in the samples, graded or not. */
  sampled: number;
  /** The sample ids, in file order. */
  samples: string[];
}

/**
 * What the sweep has to work with: the samples in the calibration folder (or
 * the one for `only`) and the lines of `grades.jsonl` that belong to them.
 * Throws a readable error when there is nothing to compare, so the runner
 * stops before it spends anything.
 */
export function calibrationInputs(
  only?: string,
  dir = defaultCalibrationDir()
): CalibrationInputs {
  const samples = loadCalibrationSamples(dir, only);
  if (samples.length === 0) {
    throw new Error(
      `No calibration sample in ${dir}. Make one from a finished sweep with npm --prefix agent run calibration-sample -- <sweep id>.`
    );
  }
  const graded = gradedItems(samples, loadHumanGrades(join(dir, GRADES_FILE)));
  if (graded.length === 0) {
    throw new Error(
      `You have not graded any reply of ${samples.map((sample) => sample.sampleId).join(", ")}. Grade them in the viewer (make eval-viewer-dev), so ${join(dir, GRADES_FILE)} has lines, and run this again.`
    );
  }
  return {
    graded: graded.length,
    sampled: samples.reduce((sum, sample) => sum + sample.items.length, 0),
    samples: samples.map((sample) => sample.sampleId),
  };
}

export interface CalibrationReading {
  comparisons: ItemComparison[];
  /** The judge check's judge-call count of replies the judge could not answer, with why. */
  notGraded: { id: string; reason: string }[];
  /** The judge rubric hash of the run. */
  rubric?: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the rows of the agreement eval. A row with no comparison counts as not graded. */
export function readCalibration(
  rows: readonly RecordedEvalResult[]
): CalibrationReading {
  const reading: CalibrationReading = { comparisons: [], notGraded: [] };
  for (const row of rows) {
    const id = textOf(row.metadata.itemId) ?? row.id;
    const assertion = row.assertions.find(
      (candidate) => candidate.name === CALIBRATION_LABEL
    );
    const metadata = assertion?.metadata ?? {};
    reading.rubric ??= textOf(metadata.rubric);
    const parsed = itemComparisonSchema.safeParse(metadata.comparison);
    if (
      assertion !== undefined &&
      metadata.notGraded !== true &&
      parsed.success
    ) {
      reading.comparisons.push(parsed.data);
      continue;
    }
    reading.notGraded.push({
      id: textOf(metadata.calibrationId) ?? id,
      reason:
        textOf(metadata.reason) ??
        assertion?.message ??
        row.error ??
        row.skipReason ??
        "The eval recorded no comparison.",
    });
  }
  return reading;
}

export interface CalibrationReportInput {
  costUsd: number;
  humanGraded: number;
  judgeModel: string;
  reading: CalibrationReading;
  samples: readonly string[];
  sweepId: string;
}

/**
 * The report for a pass that ran to its end. A reply you graded that has no
 * comparison and no not-graded row, because the pass never recorded one, counts
 * as not graded by the judge.
 */
export function calibrationReportOf(
  input: CalibrationReportInput,
  now = new Date()
): CalibrationReport {
  const { comparisons, notGraded } = input.reading;
  return buildCalibrationReport({
    comparisons,
    costUsd: input.costUsd,
    generatedAt: now.toISOString(),
    humanGraded: input.humanGraded,
    judge: { model: input.judgeModel },
    notGraded: Math.max(
      notGraded.length,
      input.humanGraded - comparisons.length
    ),
    rubricHash: input.reading.rubric,
    samples: input.samples,
    sweepId: input.sweepId,
  });
}

/** Writes `<sweep id>.calibration.json`. Returns the path. */
export function writeCalibrationReport(
  reportsDir: string,
  report: CalibrationReport
): string {
  mkdirSync(reportsDir, { recursive: true });
  const path = join(reportsDir, calibrationReportFileName(report.sweepId));
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
