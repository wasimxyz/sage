import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseSweepFile } from "../../evals/lib/schema.ts";
import { personPassFiles, readTranscripts, setupPassFiles } from "./collect.ts";
import {
  appendMemoryReading,
  memoryReadingsPath,
  readMemoryReadings,
} from "./memory-pressure.ts";
import {
  checkResume,
  createProgress,
  describeResume,
  doneCounts,
  dropMemoryReadings,
  isDone,
  markDone,
  markerPath,
  newPlanFile,
  pendingWork,
  planFileFor,
  planPath,
  ResumeError,
  readMarker,
  readPlanFile,
  resetStep,
  savedManifestPath,
  sweepHash,
  writePlanFile,
} from "./resume.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern2 =
  /Resuming run-1 \(screen, started 2026-11-15T10:00:00\.000Z, run 2 times before, 1\.5 hours so far\)/u;
const pattern1 =
  /the judge check, 2 person passes, 2 chat passes, 1 grade pass\./u;

const SETUP = "a1a1a1a1a1";
const OTHER_SETUP = "b2b2b2b2b2";
const DREAM_KEY = "dk01";

const current = {
  people: ["jo", "sam"],
  setupIds: [SETUP, OTHER_SETUP],
  sweepFile: "screen",
  sweepHash: "0123456789abcdef",
};

const nothingPattern = /Nothing to resume: .* has no plan\.json/u;
const hashPattern =
  /The sweep changed since run-1 started \(screen: hash 0123456789abcdef then, ffffffffffffffff now\)/u;
const setupsPattern = /The setups of run-1 changed: now also c3c3c3c3c3/u;
const peoplePattern =
  /The people of run-1 changed: now also kim; no longer jo/u;

// ---------------------------------------------------------------------------
// The sweep's hash
// ---------------------------------------------------------------------------

test("the hash covers the resolved sweep: an edit, a default, and a model list all change it", () => {
  const base = sweepHash(parseSweepFile({ tests: ["person"] }));
  assert.equal(base, sweepHash(parseSweepFile({ tests: ["person"] })));
  assert.equal(
    base,
    sweepHash(parseSweepFile({ repeats: 1, tests: ["person"] })),
    "a value that is the default is the same sweep"
  );
  for (const change of [
    { repeats: 2 },
    { chatModels: ["other:1b"] },
    { spendingCapUsd: 10 },
    { judge: { model: "acme/other" } },
    { tags: ["screen"] },
    { speedLimitSeconds: 30 },
  ]) {
    assert.notEqual(
      base,
      sweepHash(parseSweepFile({ tests: ["person"], ...change })),
      JSON.stringify(change)
    );
  }
});

// ---------------------------------------------------------------------------
// The plan file
// ---------------------------------------------------------------------------

test("a new run's plan file records the sweep, its setups, and its people, sorted", () => {
  const plan = newPlanFile("run-1", current, new Date("2026-11-15T10:00:00Z"));
  assert.deepEqual(plan, {
    createdAt: "2026-11-15T10:00:00.000Z",
    people: ["jo", "sam"],
    priorMs: 0,
    sessions: 0,
    setupIds: [SETUP, OTHER_SETUP],
    sweepFile: "screen",
    sweepHash: "0123456789abcdef",
    sweepId: "run-1",
    version: 1,
  });
  assert.deepEqual(
    newPlanFile("run-1", { ...current, people: ["sam", "jo"] }).people,
    ["jo", "sam"]
  );
});

test("a plan file is written and read back, and a missing or broken one reads as none", (t) => {
  const runDir = tempDir(t);
  assert.equal(readPlanFile(runDir), null);
  const plan = newPlanFile("run-1", current);
  writePlanFile(runDir, plan);
  assert.deepEqual(readPlanFile(runDir), plan);
  writeFileSync(planPath(runDir), "{ not json");
  assert.equal(readPlanFile(runDir), null);
  writeFileSync(planPath(runDir), JSON.stringify({ sweepId: "run-1" }));
  assert.equal(readPlanFile(runDir), null);
});

test("a resume checks the plan it recorded, and a new run gets a new one", () => {
  const recorded = newPlanFile("run-1", current);
  assert.equal(planFileFor("run-1", recorded, current, true), recorded);
  const fresh = planFileFor("run-2", null, current, false);
  assert.equal(fresh.sweepId, "run-2");
  assert.equal(fresh.sessions, 0);
});

test("a resume goes on when nothing changed, however the lists are ordered", () => {
  const recorded = newPlanFile("run-1", current);
  assert.equal(
    checkResume("run-1", recorded, {
      ...current,
      people: ["sam", "jo"],
      setupIds: [OTHER_SETUP, SETUP],
    }),
    recorded
  );
});

test("a resume refuses when the run has no plan, or the resolved sweep hashes differently", () => {
  assert.throws(
    () => checkResume("run-1", null, current),
    (error: unknown) =>
      error instanceof ResumeError && nothingPattern.test(error.message)
  );
  const recorded = newPlanFile("run-1", current);
  assert.throws(
    () =>
      checkResume("run-1", recorded, {
        ...current,
        sweepHash: "ffffffffffffffff",
      }),
    (error: unknown) =>
      error instanceof ResumeError &&
      hashPattern.test(error.message) &&
      error.message.includes("SAGE_CHAT_MODELS") &&
      error.message.includes("start a new run")
  );
});

test("a resume refuses when the setups or the people are not the ones the run started with", () => {
  const recorded = newPlanFile("run-1", current);
  assert.throws(
    () =>
      checkResume("run-1", recorded, {
        ...current,
        setupIds: [...current.setupIds, "c3c3c3c3c3"],
      }),
    setupsPattern
  );
  assert.throws(
    () =>
      checkResume("run-1", recorded, { ...current, people: ["sam", "kim"] }),
    peoplePattern
  );
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const personStep = {
  dreamKeyId: DREAM_KEY,
  kind: "person",
  person: "sam",
} as const;
const chatStep = { kind: "chat", person: "sam", setupId: SETUP } as const;
const gradeStep = { kind: "grade", person: "sam", setupId: SETUP } as const;

test("a step is done only when its marker exists, and a marker can carry data", (t) => {
  const runDir = tempDir(t);
  for (const step of [
    personStep,
    chatStep,
    gradeStep,
    { kind: "judge-check" } as const,
  ]) {
    assert.equal(isDone(runDir, step), false);
  }
  markDone(runDir, chatStep);
  markDone(runDir, { kind: "judge-check" }, { passed: true });
  assert.equal(isDone(runDir, chatStep), true);
  assert.equal(isDone(runDir, gradeStep), false, "grading is its own step");
  assert.equal(isDone(runDir, { ...chatStep, person: "jo" }), false);
  assert.equal(isDone(runDir, { ...chatStep, setupId: OTHER_SETUP }), false);
  assert.deepEqual(readMarker(runDir, { kind: "judge-check" })?.data, {
    passed: true,
  });
  assert.equal(readMarker(runDir, gradeStep), null);
  assert.equal(
    markerPath(runDir, chatStep),
    join(runDir, "done", "chat", SETUP, "sam.json")
  );
});

function leaveChatFiles(runDir: string, setupId: string, person: string): void {
  const chat = setupPassFiles(runDir, setupId, person, "chat");
  const grade = setupPassFiles(runDir, setupId, person, "grade");
  mkdirSync(chat.dir, { recursive: true });
  for (const path of [
    chat.results,
    chat.log,
    chat.transcripts,
    grade.results,
    grade.log,
  ]) {
    writeFileSync(path, "partial\n");
  }
}

test("starting a chat pass over deletes what it left: its rows, its transcripts, its log, its readings, and the grades of those replies", (t) => {
  const runDir = tempDir(t);
  leaveChatFiles(runDir, SETUP, "sam");
  leaveChatFiles(runDir, SETUP, "jo");
  leaveChatFiles(runDir, OTHER_SETUP, "sam");
  markDone(runDir, chatStep);
  markDone(runDir, gradeStep);
  const reading = (peakGrowthMB: number) => ({
    baselineMB: 100,
    modelSizeMB: 5000,
    peakGrowthMB,
    samples: 4,
  });
  appendMemoryReading(runDir, SETUP, "sam", reading(20));
  appendMemoryReading(runDir, SETUP, "jo", reading(30));

  resetStep(runDir, chatStep);

  const chat = setupPassFiles(runDir, SETUP, "sam", "chat");
  const grade = setupPassFiles(runDir, SETUP, "sam", "grade");
  for (const path of [
    chat.results,
    chat.log,
    chat.transcripts,
    grade.results,
    grade.log,
    markerPath(runDir, chatStep),
    markerPath(runDir, gradeStep),
  ]) {
    assert.equal(existsSync(path), false, path);
  }
  // Another person's files, and another setup's, are not touched.
  for (const [setup, person] of [
    [SETUP, "jo"],
    [OTHER_SETUP, "sam"],
  ] as const) {
    assert.ok(
      existsSync(setupPassFiles(runDir, setup, person, "chat").transcripts)
    );
    assert.ok(
      existsSync(setupPassFiles(runDir, setup, person, "grade").results)
    );
  }
  assert.deepEqual(
    readMemoryReadings(runDir, SETUP).map((kept) => kept.peakGrowthMB),
    [30]
  );
});

test("starting a grade pass over keeps the replies it graded", (t) => {
  const runDir = tempDir(t);
  leaveChatFiles(runDir, SETUP, "sam");
  markDone(runDir, chatStep);
  markDone(runDir, gradeStep);
  resetStep(runDir, gradeStep);
  const chat = setupPassFiles(runDir, SETUP, "sam", "chat");
  const grade = setupPassFiles(runDir, SETUP, "sam", "grade");
  assert.ok(existsSync(chat.transcripts));
  assert.ok(existsSync(chat.results));
  assert.equal(existsSync(grade.results), false);
  assert.equal(existsSync(grade.log), false);
  assert.equal(isDone(runDir, chatStep), true);
  assert.equal(isDone(runDir, gradeStep), false);
});

test("starting a person pass over deletes its rows and keeps the seed log and the saved manifest", (t) => {
  const runDir = tempDir(t);
  const files = personPassFiles(runDir, DREAM_KEY, "sam");
  mkdirSync(files.dir, { recursive: true });
  for (const path of [files.results, files.log]) {
    writeFileSync(path, "partial\n");
  }
  writeFileSync(join(files.dir, "seed.log"), "seeded\n");
  writeFileSync(savedManifestPath(runDir, DREAM_KEY, "sam"), "{}\n");
  markDone(runDir, personStep);
  resetStep(runDir, personStep);
  assert.equal(existsSync(files.results), false);
  assert.equal(existsSync(files.log), false);
  assert.equal(isDone(runDir, personStep), false);
  assert.ok(existsSync(join(files.dir, "seed.log")));
  assert.ok(existsSync(savedManifestPath(runDir, DREAM_KEY, "sam")));
});

test("starting the judge check over deletes its rows, so none is counted twice", (t) => {
  const runDir = tempDir(t);
  const dir = join(runDir, "judge-check");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "judge-check.results.jsonl"), "partial\n");
  markDone(runDir, { kind: "judge-check" });
  resetStep(runDir, { kind: "judge-check" });
  assert.equal(existsSync(dir), false);
  assert.equal(isDone(runDir, { kind: "judge-check" }), false);
});

test("a killed chat pass leaves no row behind once it starts over: the transcripts hold each reply once", (t) => {
  const runDir = tempDir(t);
  const chat = setupPassFiles(runDir, SETUP, "sam", "chat");
  mkdirSync(chat.dir, { recursive: true });
  const row = (reply: string) =>
    `${JSON.stringify({
      ended: "done",
      itemId: "sam/chat/1",
      journal: "own",
      kind: "chat",
      person: "sam",
      repeat: 1,
      setupId: SETUP,
      turns: [
        { role: "user", text: "How was my week?" },
        { role: "assistant", text: reply },
      ],
    })}\n`;
  // The first pass wrote a row, then was killed before it could finish.
  writeFileSync(chat.transcripts, row("From the killed pass."));
  // With no marker, the next pass starts from scratch and writes its own.
  resetStep(runDir, chatStep);
  writeFileSync(chat.transcripts, row("From the new pass."), { flag: "a" });
  const rows = readTranscripts(chat.transcripts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.turns[1]?.text, "From the new pass.");
});

test("a memory reading is dropped for one person only, and a line cut short goes with it", (t) => {
  const runDir = tempDir(t);
  appendMemoryReading(runDir, SETUP, "sam", { baselineMB: 1 } as never);
  appendMemoryReading(runDir, SETUP, "jo", { baselineMB: 2 } as never);
  writeFileSync(memoryReadingsPath(runDir, SETUP), '{"person":"sam","ba', {
    flag: "a",
  });
  dropMemoryReadings(runDir, SETUP, "sam");
  const kept = readFileSync(memoryReadingsPath(runDir, SETUP), "utf8")
    .trim()
    .split("\n");
  assert.equal(kept.length, 1);
  assert.equal(JSON.parse(kept[0] ?? "{}").person, "jo");
  // No file is no problem.
  dropMemoryReadings(runDir, OTHER_SETUP, "sam");
});

test("the progress of a run folder asks the same files", (t) => {
  const runDir = tempDir(t);
  const progress = createProgress(runDir);
  assert.equal(progress.isDone(chatStep), false);
  progress.markDone(chatStep, { why: "test" });
  assert.equal(isDone(runDir, chatStep), true);
  assert.deepEqual(progress.readMarker(chatStep)?.data, { why: "test" });
  leaveChatFiles(runDir, SETUP, "sam");
  progress.reset(chatStep);
  assert.equal(isDone(runDir, chatStep), false);
});

// ---------------------------------------------------------------------------
// What is left
// ---------------------------------------------------------------------------

const unit = {
  dreamKeyId: DREAM_KEY,
  lists: { chat: 1, grade: 1, person: 1 },
  person: "sam",
  setupIds: [SETUP, OTHER_SETUP],
};

test("everything is left in a new run, and nothing in a finished one", (t) => {
  const runDir = tempDir(t);
  const progress = createProgress(runDir);
  assert.deepEqual(pendingWork(progress, unit), {
    chat: true,
    grade: true,
    person: true,
  });
  progress.markDone(personStep);
  for (const setupId of unit.setupIds) {
    progress.markDone({ kind: "chat", person: "sam", setupId });
    progress.markDone({ kind: "grade", person: "sam", setupId });
  }
  assert.deepEqual(pendingWork(progress, unit), {
    chat: false,
    grade: false,
    person: false,
  });
});

test("one setup left to generate, or to grade, is work left", (t) => {
  const runDir = tempDir(t);
  const progress = createProgress(runDir);
  progress.markDone(personStep);
  progress.markDone({ kind: "chat", person: "sam", setupId: SETUP });
  progress.markDone({ kind: "grade", person: "sam", setupId: SETUP });
  progress.markDone({ kind: "chat", person: "sam", setupId: OTHER_SETUP });
  // Replies are saved for both, and only the second setup is not graded.
  assert.deepEqual(pendingWork(progress, unit), {
    chat: false,
    grade: true,
    person: false,
  });
});

test("a step the filters leave out is never left, and grading needs a chat pass to read", (t) => {
  const runDir = tempDir(t);
  const progress = createProgress(runDir);
  assert.deepEqual(
    pendingWork(progress, { ...unit, lists: { chat: 0, grade: 1, person: 0 } }),
    { chat: false, grade: false, person: false }
  );
  assert.deepEqual(
    pendingWork(progress, { ...unit, lists: { chat: 1, grade: 0, person: 0 } }),
    { chat: true, grade: false, person: false }
  );
});

test("a resume says what finished, and what it spent time on so far", (t) => {
  const runDir = tempDir(t);
  markDone(runDir, { kind: "judge-check" });
  markDone(runDir, personStep);
  markDone(runDir, { ...personStep, person: "jo" });
  markDone(runDir, chatStep);
  markDone(runDir, gradeStep);
  markDone(runDir, { ...chatStep, setupId: OTHER_SETUP });
  const counts = doneCounts(runDir);
  assert.deepEqual(counts, { chat: 2, grade: 1, judgeCheck: true, person: 2 });
  const plan = {
    ...newPlanFile("run-1", current, new Date("2026-11-15T10:00:00Z")),
    priorMs: 5_400_000,
    sessions: 2,
  };
  const lines = describeResume(plan, counts);
  assert.match(lines[0] ?? "", pattern2);
  assert.match(lines[1] ?? "", pattern1);
  assert.deepEqual(doneCounts(join(runDir, "nowhere")), {
    chat: 0,
    grade: 0,
    judgeCheck: false,
    person: 0,
  });
});
