import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  type CalibrationSample,
  gradesFileName,
  type HumanGrade,
  parseCalibrationSample,
  parseGrades,
  sampleFilePattern,
  upsertGradeText,
  validateGradeInput,
} from "./calibration.ts";
import type { ParseOutcome } from "./sweep-types.ts";

// The files behind the grading form: the samples to read, and grades.jsonl to
// write. Saving is allowed only under `next dev`, and only inside the repo, or
// inside the eval content folder when `SAGE_EVAL_CONTENT` puts it elsewhere.

export const calibrationEnv = "SAGE_EVAL_CALIBRATION";
export const contentEnv = "SAGE_EVAL_CONTENT";

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * The calibration folder of the eval content: `agent/evals/content/calibration`
 * next to the viewer, or `calibration` in the folder `SAGE_EVAL_CONTENT` names,
 * or the folder in `SAGE_EVAL_CALIBRATION`. `repoRoot` is the folder the grades
 * file must stay inside: the content folder when `SAGE_EVAL_CONTENT` names one,
 * else the repo.
 */
export function calibrationLocation(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): { dir: string; repoRoot: string } {
  const repo = resolve(cwd, "..");
  const content = env[contentEnv];
  const root = isSet(content) ? resolve(cwd, content) : repo;
  const contentDir = isSet(content)
    ? resolve(cwd, content)
    : join(repo, "agent", "evals", "content");
  const override = env[calibrationEnv];
  const dir = isSet(override)
    ? resolve(cwd, override)
    : join(contentDir, "calibration");
  return { dir, repoRoot: root };
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  );
}

/** The real path of a file that may not exist yet: its nearest folder that does, with the rest added back. */
async function realPathOf(path: string): Promise<string> {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each step needs the failure of the one before it
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return resolve(path);
      }
      rest.push(basename(current));
      current = parent;
    }
  }
}

export type SaveGuard =
  | { gradesPath: string; ok: true }
  | { ok: false; reason: string };

export interface SaveGuardInput {
  /** The folder that holds the samples and grades.jsonl. */
  dir: string;
  /** `process.env.NODE_ENV`. Only `development`, which is what `next dev` sets, may save. */
  nodeEnv: string | undefined;
  repoRoot: string;
}

/**
 * Decides whether grades may be written, and where. It refuses in any build
 * but `next dev`, and when the path, after links are followed, is outside the
 * repo. The grades file itself is checked too, so a link named grades.jsonl
 * cannot point elsewhere.
 */
export async function guardGradesPath(
  input: SaveGuardInput
): Promise<SaveGuard> {
  if (input.nodeEnv !== "development") {
    return {
      ok: false,
      reason: "Grades save only under make eval-viewer-dev.",
    };
  }
  const [root, gradesPath] = await Promise.all([
    realPathOf(input.repoRoot),
    realPathOf(join(input.dir, gradesFileName)),
  ]);
  if (!isInside(root, gradesPath)) {
    return {
      ok: false,
      reason: "The grades file is outside the repo, so it was not written.",
    };
  }
  return { gradesPath, ok: true };
}

/** Sample file names in the folder, the newest name first. A missing folder gives none. */
export async function listSampleFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => sampleFilePattern.test(name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

export async function readSample(
  dir: string,
  fileName: string
): Promise<ParseOutcome<CalibrationSample>> {
  if (!sampleFilePattern.test(fileName)) {
    return { kind: "invalid", message: "That is not a sample file name." };
  }
  try {
    return parseCalibrationSample(await readFile(join(dir, fileName), "utf8"));
  } catch {
    return { kind: "invalid", message: "Could not read the sample file." };
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Every human grade in the folder's grades.jsonl. A missing file gives none. */
export async function readGrades(dir: string): Promise<HumanGrade[]> {
  return parseGrades(await readText(join(dir, gradesFileName)));
}

export interface SaveRequest {
  dir: string;
  input: unknown;
  nodeEnv: string | undefined;
  /** Used as `gradedAt`. */
  now: Date;
  repoRoot: string;
  sampleFile: string;
}

export type SaveResult =
  | { gradedAt: string; ok: true }
  | { ok: false; reason: string };

// One write at a time, so two quick saves cannot read the same old file.
let writing: Promise<unknown> = Promise.resolve();

async function writeGrade(
  gradesPath: string,
  grade: HumanGrade
): Promise<void> {
  const text = upsertGradeText(await readText(gradesPath), grade);
  await mkdir(dirname(gradesPath), { recursive: true });
  const temporary = `${gradesPath}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, gradesPath);
}

/** Saves one item's grade into grades.jsonl, after the guard and the input check. */
export function saveGrade(request: SaveRequest): Promise<SaveResult> {
  const run = async (): Promise<SaveResult> => {
    const guard = await guardGradesPath(request);
    if (!guard.ok) {
      return guard;
    }
    const sample = await readSample(request.dir, request.sampleFile);
    if (sample.kind !== "ok") {
      return { ok: false, reason: sample.message };
    }
    const checked = validateGradeInput(sample.value, request.input);
    if (!checked.ok) {
      return checked;
    }
    const gradedAt = request.now.toISOString();
    await writeGrade(guard.gradesPath, { ...checked.grade, gradedAt });
    return { gradedAt, ok: true };
  };
  const result = writing.then(run, run);
  writing = result.catch(() => undefined);
  return result.catch(
    (): SaveResult => ({
      ok: false,
      reason: "Could not write the grades file.",
    })
  );
}
