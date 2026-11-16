"use server";

import type { GradeInput } from "@/lib/reports/calibration.ts";
import {
  calibrationLocation,
  type SaveResult,
  saveGrade as saveToFile,
} from "@/lib/reports/calibration-store.ts";

/**
 * Saves one item's grade into grades.jsonl. It works only under `next dev`
 * and only inside the repo. The store checks both, and checks the grade
 * against the sample on disk, so a request that does not come from the form
 * writes nothing.
 */
export async function saveGrade(
  sampleFile: string,
  input: GradeInput
): Promise<SaveResult> {
  if (typeof sampleFile !== "string") {
    return { ok: false, reason: "The sample file name is missing." };
  }
  const { dir, repoRoot } = calibrationLocation(process.env, process.cwd());
  return await saveToFile({
    dir,
    input,
    nodeEnv: process.env.NODE_ENV,
    now: new Date(),
    repoRoot,
    sampleFile,
  });
}
