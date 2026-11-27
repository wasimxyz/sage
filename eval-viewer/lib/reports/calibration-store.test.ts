import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { parseGrades } from "./calibration.ts";
import {
  calibrationLocation,
  guardGradesPath,
  listSampleFiles,
  readGrades,
  readSample,
  saveGrade,
} from "./calibration-store.ts";
import {
  sampleCalibration,
  sampleCalibrationFileName,
} from "./sweep-samples.ts";

const roots: string[] = [];

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** A folder shaped like the repo, with the calibration folder and a sample in it, and a folder outside it. */
async function makeRepo(): Promise<{
  dir: string;
  outside: string;
  repoRoot: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "sage-calibration-test-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  const dir = join(repoRoot, "agent", "evals", "calibration");
  const outside = join(base, "outside");
  await mkdir(dir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(dir, sampleCalibrationFileName),
    JSON.stringify(sampleCalibration())
  );
  return { dir, outside, repoRoot };
}

const goodInput = {
  checks: { "crisis-handled": true, "no-overreach": false },
  id: "c01",
  note: "diagnosis",
  rubric: { "right-help": 2, warmth: 4 },
};

const now = new Date("2026-11-16T10:00:00.000Z");

test("calibrationLocation uses the folder next to the viewer, or the one in the environment", () => {
  assert.deepEqual(calibrationLocation({}, "/work/sage/eval-viewer"), {
    dir: "/work/sage/agent/evals/calibration",
    repoRoot: "/work/sage",
  });
  assert.equal(
    calibrationLocation(
      { SAGE_EVAL_CALIBRATION: "/work/sage/tmp/cal" },
      "/work/sage/eval-viewer"
    ).dir,
    "/work/sage/tmp/cal"
  );
  assert.equal(
    calibrationLocation(
      { SAGE_EVAL_CALIBRATION: "  " },
      "/work/sage/eval-viewer"
    ).dir,
    "/work/sage/agent/evals/calibration"
  );
  assert.equal(
    calibrationLocation(
      { SAGE_EVAL_CALIBRATION: "../tmp/cal" },
      "/work/sage/eval-viewer"
    ).dir,
    "/work/sage/tmp/cal"
  );
});

test("the guard allows a save under next dev, inside the repo", async () => {
  const { dir, repoRoot } = await makeRepo();
  const guard = await guardGradesPath({
    dir,
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(guard.ok, true);
  if (guard.ok) {
    assert.ok(guard.gradesPath.endsWith(join("calibration", "grades.jsonl")));
  }
});

test("the guard refuses in a production build and when the mode is unknown", async () => {
  const { dir, repoRoot } = await makeRepo();
  const modes = ["production", "test", "", undefined];
  const guards = await Promise.all(
    modes.map((nodeEnv) => guardGradesPath({ dir, nodeEnv, repoRoot }))
  );
  for (const [position, guard] of guards.entries()) {
    assert.equal(guard.ok, false, String(modes[position]));
    if (!guard.ok) {
      assert.ok(guard.reason.includes("make eval-viewer-dev"));
    }
  }
});

test("the guard refuses a folder outside the repo", async () => {
  const { outside, repoRoot } = await makeRepo();
  const guard = await guardGradesPath({
    dir: outside,
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(guard.ok, false);
  if (!guard.ok) {
    assert.ok(guard.reason.includes("outside the repo"));
  }
  const sibling = await guardGradesPath({
    dir: `${repoRoot}-other/calibration`,
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(sibling.ok, false);
  const climbing = await guardGradesPath({
    dir: join(repoRoot, "agent", "..", "..", "outside"),
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(climbing.ok, false);
});

test("the guard refuses a folder that is a link to somewhere outside the repo", async () => {
  const { outside, repoRoot } = await makeRepo();
  const linked = join(repoRoot, "linked");
  await symlink(outside, linked);
  const guard = await guardGradesPath({
    dir: linked,
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(guard.ok, false);
});

test("the guard refuses a grades file that is a link to somewhere outside the repo", async () => {
  const { dir, outside, repoRoot } = await makeRepo();
  await writeFile(join(outside, "elsewhere.jsonl"), "");
  await symlink(join(outside, "elsewhere.jsonl"), join(dir, "grades.jsonl"));
  const guard = await guardGradesPath({
    dir,
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(guard.ok, false);
});

test("the guard allows a folder that does not exist yet, inside the repo", async () => {
  const { repoRoot } = await makeRepo();
  const guard = await guardGradesPath({
    dir: join(repoRoot, "agent", "evals", "new", "calibration"),
    nodeEnv: "development",
    repoRoot,
  });
  assert.equal(guard.ok, true);
});

test("listSampleFiles gives sample files, the newest name first", async () => {
  const { dir } = await makeRepo();
  await writeFile(join(dir, "sample-2026-11-20.json"), "{}");
  await writeFile(join(dir, "grades.jsonl"), "");
  await writeFile(join(dir, "notes.json"), "{}");
  assert.deepEqual(await listSampleFiles(dir), [
    "sample-2026-11-20.json",
    sampleCalibrationFileName,
  ]);
  assert.deepEqual(await listSampleFiles(join(dir, "missing")), []);
});

test("readSample reads a sample and refuses a name that is not a sample file", async () => {
  const { dir } = await makeRepo();
  const sample = await readSample(dir, sampleCalibrationFileName);
  assert.equal(sample.kind, "ok");
  assert.equal((await readSample(dir, "../grades.jsonl")).kind, "invalid");
  assert.equal((await readSample(dir, "sample-missing.json")).kind, "invalid");
});

test("saveGrade writes a line, then replaces it, and keeps the other items", async () => {
  const { dir, repoRoot } = await makeRepo();
  const request = {
    dir,
    nodeEnv: "development",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  };
  const first = await saveGrade({ ...request, input: goodInput });
  assert.deepEqual(first, { gradedAt: now.toISOString(), ok: true });
  await saveGrade({
    ...request,
    input: {
      checks: { "crisis-handled": true },
      id: "c02",
      note: "",
      rubric: {},
    },
  });
  const changed = await saveGrade({
    ...request,
    input: { ...goodInput, note: "changed" },
    now: new Date("2026-11-16T11:00:00.000Z"),
  });
  assert.equal(changed.ok, true);

  const text = await readFile(join(dir, "grades.jsonl"), "utf8");
  assert.equal(text.trim().split("\n").length, 2);
  const grades = await readGrades(dir);
  assert.deepEqual(
    grades.map((grade) => [grade.id, grade.note, grade.gradedAt]),
    [
      ["c01", "changed", "2026-11-16T11:00:00.000Z"],
      ["c02", "", "2026-11-16T10:00:00.000Z"],
    ]
  );
  assert.deepEqual(grades[0]?.checks, {
    "crisis-handled": true,
    "no-overreach": false,
  });
  assert.deepEqual(grades[0]?.rubric, { "right-help": 2, warmth: 4 });
  assert.equal(grades[0]?.grader, "human");
  assert.equal(grades[0]?.sampleId, "sample-2026-11-16");
});

test("saveGrade writes nothing in a production build", async () => {
  const { dir, repoRoot } = await makeRepo();
  const result = await saveGrade({
    dir,
    input: goodInput,
    nodeEnv: "production",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(await readGrades(dir), []);
  await assert.rejects(readFile(join(dir, "grades.jsonl"), "utf8"));
});

test("saveGrade writes nothing outside the repo", async () => {
  const { outside, repoRoot } = await makeRepo();
  await writeFile(
    join(outside, sampleCalibrationFileName),
    JSON.stringify(sampleCalibration())
  );
  const result = await saveGrade({
    dir: outside,
    input: goodInput,
    nodeEnv: "development",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  });
  assert.equal(result.ok, false);
  await assert.rejects(readFile(join(outside, "grades.jsonl"), "utf8"));
});

test("saveGrade refuses an item or a key the sample does not have, and a name that climbs out", async () => {
  const { dir, repoRoot } = await makeRepo();
  const request = {
    dir,
    nodeEnv: "development",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  };
  const unknownItem = await saveGrade({ ...request, input: { id: "zzz" } });
  assert.equal(unknownItem.ok, false);
  const unknownKey = await saveGrade({
    ...request,
    input: { checks: { warmth: true }, id: "c01" },
  });
  assert.equal(unknownKey.ok, false);
  const climbing = await saveGrade({
    ...request,
    input: goodInput,
    sampleFile: "../sample-x.json",
  });
  assert.equal(climbing.ok, false);
  await assert.rejects(readFile(join(dir, "grades.jsonl"), "utf8"));
});

test("saveGrade keeps every grade when saves arrive together", async () => {
  const { dir, repoRoot } = await makeRepo();
  const request = {
    dir,
    nodeEnv: "development",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  };
  const results = await Promise.all(
    ["c01", "c02", "c03"].map((id) =>
      saveGrade({ ...request, input: { checks: {}, id, note: id, rubric: {} } })
    )
  );
  assert.ok(results.every((result) => result.ok));
  const grades = parseGrades(await readFile(join(dir, "grades.jsonl"), "utf8"));
  assert.deepEqual(grades.map((grade) => grade.id).sort(), [
    "c01",
    "c02",
    "c03",
  ]);
});

test("saveGrade leaves the lines it cannot read in the file", async () => {
  const { dir, repoRoot } = await makeRepo();
  await writeFile(join(dir, "grades.jsonl"), "keep this line\n");
  await saveGrade({
    dir,
    input: goodInput,
    nodeEnv: "development",
    now,
    repoRoot,
    sampleFile: sampleCalibrationFileName,
  });
  const lines = (await readFile(join(dir, "grades.jsonl"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(lines[0], "keep this line");
  assert.equal(lines.length, 2);
});
