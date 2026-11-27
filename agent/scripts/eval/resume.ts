// Resuming a sweep that stopped halfway.
//
// A sweep that runs for hours can be stopped by Ctrl-C, a crash, or a lid that
// closes. Its run folder, `agent/evals/.runs/<sweep id>/`, keeps what it needs
// to go on:
//
//   plan.json                              the sweep's name, the hash of its resolved file, its setups, its people
//   done/judge-check.json                  the judge check passed
//   done/person/<dream key>/<person>.json  the person pass finished
//   done/chat/<setup>/<person>.json        the chat pass (generation) finished
//   done/grade/<setup>/<person>.json       the grade pass finished
//   ledger.jsonl                           the spending, which counts across runs
//
// `--resume <sweep id>` runs the sweep again under the same id and skips each
// step that has a marker. Generation and grading are separate steps, so a
// setup whose replies were saved but not graded is only graded again. A step
// with no marker starts from scratch: what it left behind is deleted first.
// Transcripts are appended to, so a pass that was killed halfway would
// otherwise leave rows that the next pass writes a second time.
//
// A resume refuses when the sweep file, with its model overrides and
// defaults, no longer hashes to what the plan recorded, or when the setups or
// the people are not the same.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { SweepFile } from "../../evals/lib/schema.ts";
import { personPassDir, setupPassFiles } from "./collect.ts";
import { memoryReadingsPath } from "./memory-pressure.ts";
import { resolvedSweepJson } from "./sweep.ts";

export const PLAN_FILE = "plan.json";
export const DONE_DIR = "done";
export const PLAN_VERSION = 1;

const SHORT_HASH_LENGTH = 16;
const lineBreakPattern = /\r?\n/u;

/** The hash of the resolved sweep: the file, its model overrides, and every default. */
export function sweepHash(sweep: SweepFile): string {
  return createHash("sha256")
    .update(resolvedSweepJson(sweep))
    .digest("hex")
    .slice(0, SHORT_HASH_LENGTH);
}

// ---------------------------------------------------------------------------
// The plan file
// ---------------------------------------------------------------------------

export interface PlanFile {
  createdAt: string;
  /** The people the sweep covers, sorted. */
  people: string[];
  /** Milliseconds the sweep has run, over the sessions that have ended. */
  priorMs: number;
  /** How many times the run has been started, counting the first. */
  sessions: number;
  /** Every setup id the sweep expands to, sorted. */
  setupIds: string[];
  /** The sweep file's name, such as `screen`. */
  sweepFile: string;
  sweepHash: string;
  sweepId: string;
  version: typeof PLAN_VERSION;
}

export function planPath(runDir: string): string {
  return join(runDir, PLAN_FILE);
}

export function writePlanFile(runDir: string, plan: PlanFile): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(planPath(runDir), `${JSON.stringify(plan, null, 2)}\n`);
}

function isPlanFile(value: unknown): value is PlanFile {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const plan = value as Record<string, unknown>;
  return (
    plan.version === PLAN_VERSION &&
    typeof plan.sweepId === "string" &&
    typeof plan.sweepFile === "string" &&
    typeof plan.sweepHash === "string" &&
    Array.isArray(plan.setupIds) &&
    Array.isArray(plan.people) &&
    typeof plan.priorMs === "number" &&
    typeof plan.sessions === "number" &&
    typeof plan.createdAt === "string"
  );
}

/** Reads the plan file. Null when the run folder has none or it cannot be read. */
export function readPlanFile(runDir: string): PlanFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(planPath(runDir), "utf8"));
    return isPlanFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The plan file of a sweep about to begin. */
export function newPlanFile(
  sweepId: string,
  current: CurrentPlan,
  now = new Date()
): PlanFile {
  return {
    createdAt: now.toISOString(),
    people: sorted(current.people),
    priorMs: 0,
    sessions: 0,
    setupIds: sorted(current.setupIds),
    sweepFile: current.sweepFile,
    sweepHash: current.sweepHash,
    sweepId,
    version: PLAN_VERSION,
  };
}

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export interface CurrentPlan {
  people: readonly string[];
  setupIds: readonly string[];
  sweepFile: string;
  sweepHash: string;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);
}

function listDifference(
  recorded: readonly string[],
  current: readonly string[]
): string {
  const added = current.filter((value) => !recorded.includes(value));
  const removed = recorded.filter((value) => !current.includes(value));
  return [
    added.length > 0 ? `now also ${added.join(", ")}` : "",
    removed.length > 0 ? `no longer ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The plan of the run that is about to start. A new run gets a new plan file.
 * A resumed run gets the one it recorded, after `checkResume` passes.
 */
export function planFileFor(
  sweepId: string,
  recorded: PlanFile | null,
  current: CurrentPlan,
  resuming: boolean
): PlanFile {
  return resuming
    ? checkResume(sweepId, recorded, current)
    : newPlanFile(sweepId, current);
}

/**
 * Checks that the sweep about to run is the one the run folder started. Throws
 * a `ResumeError` that says what changed. A changed file would mix results
 * from two different settings in one report.
 */
export function checkResume(
  sweepId: string,
  recorded: PlanFile | null,
  current: CurrentPlan
): PlanFile {
  if (recorded === null) {
    throw new ResumeError(
      `Nothing to resume: ${sweepId} has no ${PLAN_FILE}. A run writes it at the start, so this id is wrong or the run never began.`
    );
  }
  if (recorded.sweepHash !== current.sweepHash) {
    throw new ResumeError(
      `The sweep changed since ${sweepId} started (${recorded.sweepFile}: hash ${recorded.sweepHash} then, ${current.sweepHash} now). That covers the sweep file, a model list set in the environment (SAGE_CHAT_MODELS and the others), and defaults the schema fills in. Put it back as it was, or start a new run.`
    );
  }
  if (!sameList(recorded.setupIds, current.setupIds)) {
    throw new ResumeError(
      `The setups of ${sweepId} changed: ${listDifference(recorded.setupIds, current.setupIds)}. Start a new run.`
    );
  }
  if (!sameList(recorded.people, current.people)) {
    throw new ResumeError(
      `The people of ${sweepId} changed: ${listDifference(recorded.people, current.people)}. Start a new run.`
    );
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Steps and markers
// ---------------------------------------------------------------------------

/** One piece of work with its own done marker. */
export type Step =
  | { kind: "chat"; person: string; setupId: string }
  | { kind: "grade"; person: string; setupId: string }
  | { kind: "judge-check" }
  | { dreamKeyId: string; kind: "person"; person: string };

/** The marker file of a step. */
export function markerPath(runDir: string, step: Step): string {
  const base = join(runDir, DONE_DIR);
  switch (step.kind) {
    case "judge-check":
      return join(base, "judge-check.json");
    case "person":
      return join(base, "person", step.dreamKeyId, `${step.person}.json`);
    case "chat":
      return join(base, "chat", step.setupId, `${step.person}.json`);
    case "grade":
      return join(base, "grade", step.setupId, `${step.person}.json`);
    default:
      throw new Error("Unknown step.");
  }
}

export interface Marker {
  /** Anything the step wants kept, such as the judge check's summary. */
  data?: unknown;
  doneAt: string;
}

export function isDone(runDir: string, step: Step): boolean {
  return existsSync(markerPath(runDir, step));
}

export function readMarker(runDir: string, step: Step): Marker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(markerPath(runDir, step), "utf8")
    );
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Marker)
      : null;
  } catch {
    return null;
  }
}

export function markDone(runDir: string, step: Step, data?: unknown): void {
  const path = markerPath(runDir, step);
  mkdirSync(dirname(path), { recursive: true });
  const marker: Marker = {
    ...(data === undefined ? {} : { data }),
    doneAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(marker)}\n`);
}

function remove(path: string): void {
  rmSync(path, { force: true, recursive: true });
}

/** Drops the lines of one person from a setup's memory readings, so a restarted pass is not measured twice. */
export function dropMemoryReadings(
  runDir: string,
  setupId: string,
  person: string
): void {
  const path = memoryReadingsPath(runDir, setupId);
  if (!existsSync(path)) {
    return;
  }
  const kept = readFileSync(path, "utf8")
    .split(lineBreakPattern)
    .filter((line) => {
      if (line.trim().length === 0) {
        return false;
      }
      try {
        const parsed = JSON.parse(line) as { person?: unknown };
        return parsed.person !== person;
      } catch {
        // A line cut short by a kill belongs to the pass that is starting over.
        return false;
      }
    });
  writeFileSync(path, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
}

/**
 * Deletes what a step and the steps after it left, so it can start from
 * scratch: its marker, its results, its log, and for a chat pass, its
 * transcripts, its memory readings, and everything its grade pass made. Files
 * that other steps share, such as the Sage log or the manifest, stay.
 */
export function resetStep(runDir: string, step: Step): void {
  switch (step.kind) {
    case "judge-check":
      remove(markerPath(runDir, step));
      remove(join(runDir, "judge-check"));
      return;
    case "person": {
      const dir = personPassDir(runDir, step.dreamKeyId, step.person);
      remove(markerPath(runDir, step));
      remove(join(dir, "person.results.jsonl"));
      remove(join(dir, "person.log"));
      return;
    }
    case "chat": {
      const files = setupPassFiles(runDir, step.setupId, step.person, "chat");
      remove(markerPath(runDir, step));
      remove(files.results);
      remove(files.log);
      remove(files.transcripts);
      dropMemoryReadings(runDir, step.setupId, step.person);
      // The grades were of replies that are gone.
      resetStep(runDir, { ...step, kind: "grade" });
      return;
    }
    case "grade": {
      const files = setupPassFiles(runDir, step.setupId, step.person, "grade");
      remove(markerPath(runDir, step));
      remove(files.results);
      remove(files.log);
      return;
    }
    default:
      throw new Error("Unknown step.");
  }
}

/** What the runner asks of a run folder, so a unit does not need to know the files. */
export interface Progress {
  isDone: (step: Step) => boolean;
  markDone: (step: Step, data?: unknown) => void;
  readMarker: (step: Step) => Marker | null;
  reset: (step: Step) => void;
}

export function createProgress(runDir: string): Progress {
  return {
    isDone: (step) => isDone(runDir, step),
    markDone: (step, data) => markDone(runDir, step, data),
    readMarker: (step) => readMarker(runDir, step),
    reset: (step) => resetStep(runDir, step),
  };
}

/** Where a unit keeps the manifest of its seeded journal, so grading can go on without Sage. */
export function savedManifestPath(
  runDir: string,
  dreamKeyId: string,
  person: string
): string {
  return join(personPassDir(runDir, dreamKeyId, person), "manifest.json");
}

// ---------------------------------------------------------------------------
// What is left
// ---------------------------------------------------------------------------

export interface UnitState {
  chat: boolean;
  grade: boolean;
  person: boolean;
}

/**
 * Which steps of a unit still have to run. A step that the sweep's filters
 * leave out never has to run. The unit needs Sage when the person pass or a
 * chat pass is left. When only grading is left, it needs no Sage, only the
 * manifest that the unit saved after seeding.
 */
export function pendingWork(
  progress: Pick<Progress, "isDone">,
  unit: {
    dreamKeyId: string;
    lists: { chat: number; grade: number; person: number };
    person: string;
    setupIds: readonly string[];
  }
): UnitState {
  const { dreamKeyId, lists, person, setupIds } = unit;
  return {
    chat:
      lists.chat > 0 &&
      setupIds.some(
        (setupId) => !progress.isDone({ kind: "chat", person, setupId })
      ),
    // A grade pass reads the transcripts a chat pass wrote, so one never runs without the other.
    grade:
      lists.grade > 0 &&
      lists.chat > 0 &&
      setupIds.some(
        (setupId) => !progress.isDone({ kind: "grade", person, setupId })
      ),
    person:
      lists.person > 0 &&
      !progress.isDone({ dreamKeyId, kind: "person", person }),
  };
}

// ---------------------------------------------------------------------------
// Saying what is left
// ---------------------------------------------------------------------------

export interface DoneCounts {
  chat: number;
  grade: number;
  judgeCheck: boolean;
  person: number;
}

function countMarkers(dir: string): number {
  let count = 0;
  let folders: string[];
  try {
    folders = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const folder of folders) {
    try {
      count += readdirSync(join(dir, folder)).filter((name) =>
        name.endsWith(".json")
      ).length;
    } catch {
      // Not a folder of markers.
    }
  }
  return count;
}

/** How many steps of each kind a run folder has finished. */
export function doneCounts(runDir: string): DoneCounts {
  const base = join(runDir, DONE_DIR);
  return {
    chat: countMarkers(join(base, "chat")),
    grade: countMarkers(join(base, "grade")),
    judgeCheck: isDone(runDir, { kind: "judge-check" }),
    person: countMarkers(join(base, "person")),
  };
}

const MS_PER_HOUR = 3_600_000;

/** What a resume tells you before it asks to go on. */
export function describeResume(plan: PlanFile, done: DoneCounts): string[] {
  const hours = (plan.priorMs / MS_PER_HOUR).toFixed(1);
  const steps = [
    done.judgeCheck ? "the judge check" : null,
    `${done.person} person pass${done.person === 1 ? "" : "es"}`,
    `${done.chat} chat pass${done.chat === 1 ? "" : "es"}`,
    `${done.grade} grade pass${done.grade === 1 ? "" : "es"}`,
  ].filter((step): step is string => step !== null);
  return [
    `Resuming ${plan.sweepId} (${plan.sweepFile}, started ${plan.createdAt}, run ${plan.sessions} time${plan.sessions === 1 ? "" : "s"} before, ${hours} hours so far).`,
    `Finished, and skipped: ${steps.join(", ")}. Anything else starts from scratch, and the estimate below covers the whole sweep.`,
  ];
}
