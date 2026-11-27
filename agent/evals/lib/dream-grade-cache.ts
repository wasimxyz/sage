/**
 * The grade cache for Dream accuracy.
 *
 * A Dream snapshot never changes, so the judge grades each of its sources
 * once, however many Chat setups use the snapshot. The grades sit beside the
 * snapshot, in a file named for the judge model and the Dream-source rubric
 * hash (`dreamSourceRubricHash`, not the hash of the whole rubric, so a change
 * to the reply rubric keeps these grades):
 *
 *   agent/evals/.cache/dream/<snapshot key>/grades-<model>-<rubric>.jsonl
 *
 * The runner passes the snapshot key in `SAGE_EVAL_DREAM_KEY`. Without it, or
 * when the snapshot folder is not there, nothing is cached. This file never
 * creates the snapshot folder, because the runner moves the snapshot into
 * place as a whole and that fails on a folder that already exists.
 *
 * Each row also keeps a hash of what the judge was shown. The snapshot key
 * leaves `case.yaml` out on purpose, and the fact sheet lives there, so an
 * edited fact sheet must grade again.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { evalCacheDir, evalCacheEnabled, evalCacheEntryDir } from "./cache.ts";
import { type UnsupportedClaim, unsupportedClaimSchema } from "./schema.ts";

/** The variable the runner sets for the person pass. */
export const ENV_DREAM_KEY = "SAGE_EVAL_DREAM_KEY";

const lineBreakPattern = /\r?\n/u;
const unsafeNameCharacters = /[^A-Za-z0-9._-]/gu;
const safeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const INPUT_HASH_LENGTH = 16;

/** One graded source. */
export interface CachedGrade {
  claims: UnsupportedClaim[];
  gradedAt: string;
  /** Hash of the text the judge was shown. A changed input is a miss. */
  inputHash: string;
  itemId: string;
  model: string;
  rubric: string;
}

/** A short hash of the fact sheet and the item, as the judge sees them. */
export function inputHashOf(parts: { context: string; item: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.context, parts.item]))
    .digest("hex")
    .slice(0, INPUT_HASH_LENGTH);
}

/** `grades-<model>-<rubric>.jsonl`, with the model made safe for a file name. */
export function gradesFileName(model: string, rubric: string): string {
  return `grades-${model.replace(unsafeNameCharacters, "_")}-${rubric}.jsonl`;
}

export interface GradeCacheLocation {
  /** The folder that holds the snapshot folders. Defaults to the Dream cache. */
  cacheDir?: string;
  /** False when the cache is off (`SAGE_EVAL_CACHE=0`). Defaults to the environment. */
  enabled?: boolean;
  /** The snapshot key. Without one nothing is cached. */
  key: string | undefined;
  model: string;
  rubric: string;
}

/**
 * Where the grades go, or `undefined` when they should not be cached: no key,
 * a key that is not a plain name, the cache switched off, or no snapshot
 * folder yet.
 */
export function gradeCachePath(
  location: GradeCacheLocation
): string | undefined {
  const key = location.key?.trim();
  if (key === undefined || !safeKeyPattern.test(key)) {
    return undefined;
  }
  if (!(location.enabled ?? evalCacheEnabled())) {
    return undefined;
  }
  const folder = evalCacheEntryDir(key, location.cacheDir ?? evalCacheDir());
  if (!existsSync(folder)) {
    return undefined;
  }
  return join(folder, gradesFileName(location.model, location.rubric));
}

export interface GradeCache {
  /** The cached grade for this source, if the judge saw the same input. */
  get: (itemId: string, inputHash: string) => CachedGrade | undefined;
  /** The file, or `undefined` when nothing is cached. */
  readonly path: string | undefined;
  /** Remembers a grade, in memory and in the file. */
  put: (grade: CachedGrade) => void;
}

function parseRow(line: string): CachedGrade | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (json === null || typeof json !== "object") {
    return undefined;
  }
  const row = json as Record<string, unknown>;
  if (
    typeof row.itemId !== "string" ||
    typeof row.inputHash !== "string" ||
    typeof row.model !== "string" ||
    typeof row.rubric !== "string" ||
    typeof row.gradedAt !== "string" ||
    !Array.isArray(row.claims)
  ) {
    return undefined;
  }
  const claims: UnsupportedClaim[] = [];
  for (const claim of row.claims) {
    const parsed = unsupportedClaimSchema.safeParse(claim);
    if (!parsed.success) {
      return undefined;
    }
    claims.push(parsed.data);
  }
  return {
    claims,
    gradedAt: row.gradedAt,
    inputHash: row.inputHash,
    itemId: row.itemId,
    model: row.model,
    rubric: row.rubric,
  };
}

function readRows(path: string): Map<string, CachedGrade> {
  const rows = new Map<string, CachedGrade>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return rows;
  }
  for (const line of raw.split(lineBreakPattern)) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = parseRow(line);
    // A torn or foreign line is skipped. The newest row for a source wins.
    if (row !== undefined) {
      rows.set(row.itemId, row);
    }
  }
  return rows;
}

/**
 * A cache for one judge model and rubric. The file is read once, on the first
 * `get`, and each `put` appends one line, so evals that run side by side in
 * one process share what they have graded. When the location gives no path it
 * remembers nothing.
 */
export function createGradeCache(location: GradeCacheLocation): GradeCache {
  const path = gradeCachePath(location);
  let rows: Map<string, CachedGrade> | undefined;
  const load = (): Map<string, CachedGrade> => {
    if (path === undefined) {
      return new Map();
    }
    rows ??= readRows(path);
    return rows;
  };
  return {
    get(itemId, inputHash) {
      if (path === undefined) {
        return;
      }
      const row = load().get(itemId);
      const same =
        row !== undefined &&
        row.inputHash === inputHash &&
        row.model === location.model &&
        row.rubric === location.rubric;
      return same ? row : undefined;
    },
    path,
    put(grade) {
      if (path === undefined) {
        return;
      }
      load().set(grade.itemId, grade);
      try {
        appendFileSync(path, `${JSON.stringify(grade)}\n`, "utf8");
      } catch {
        // A cache that cannot be written only means the next run grades again.
      }
    },
  };
}
