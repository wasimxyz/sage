// Picks the replies you grade to calibrate the judge.
//
//   npm --prefix agent run calibration-sample -- <sweep id> [--size 40] [--seed 1]
//
// It reads a finished sweep (`agent/evals/reports/` and, when it is still
// there, `agent/evals/.runs/<sweep id>/`) and writes
// `agent/evals/content/calibration/sample-<sweep id>.json`: about 40 replies across the
// sweep's setups. The sample is stratified by kind and `expect`, so no kind of
// message crowds out the rest. It always includes the replies where a hard or
// counted check that the judge answers failed, and it keeps at least a quarter
// for replies that passed, because a judge that flags a clean reply shows up
// only there. The same sweep, size, and seed always give the same sample.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  appliedIdsOf,
  type CalibrationItem,
  type CalibrationSample,
  defaultCalibrationDir,
  factSheetOf,
  labelsOfSample,
  parseCalibrationSample,
  sampleFileName,
} from "../../evals/lib/calibration.ts";
import { checksFor } from "../../evals/lib/checks.ts";
import { exchangesOf } from "../../evals/lib/conversation-checks.ts";
import { type LoadedPerson, loadPerson } from "../../evals/lib/dataset.ts";
import { loadEmptyJournalPerson } from "../../evals/lib/reply-grade.ts";
import {
  COUNTED_CHECK_IDS,
  HARD_CHECK_IDS,
  type ReportItem,
} from "../../evals/lib/schema.ts";
import {
  defaultSweepDirs,
  loadSweepSource,
  REPLY_ITEM_KINDS,
  type SweepDirs,
  type SweepSource,
  sourceRow,
} from "../../evals/lib/sweep-source.ts";

export const DEFAULT_SAMPLE_SIZE = 40;
export const DEFAULT_SEED = 1;
/** The share of the sample kept for replies that passed, when failures could fill it. */
const PASS_SHARE = 0.25;

// ---------------------------------------------------------------------------
// A small seeded generator
// ---------------------------------------------------------------------------

const PARK_MILLER_MODULUS = 2_147_483_647;
const PARK_MILLER_MULTIPLIER = 48_271;

/**
 * A small generator that gives the same numbers for the same seed (the
 * Park-Miller "minimal standard"). It is not for secrets. It only has to
 * shuffle a list the same way every time.
 */
export function seededRandom(seed: number): () => number {
  let state = (Math.abs(Math.trunc(seed)) % (PARK_MILLER_MODULUS - 1)) + 1;
  return () => {
    state = (state * PARK_MILLER_MULTIPLIER) % PARK_MILLER_MODULUS;
    return (state - 1) / (PARK_MILLER_MODULUS - 1);
  };
}

/** A shuffled copy, by Fisher-Yates. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = copy[index] as T;
    copy[index] = copy[other] as T;
    copy[other] = held;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** A reply that could be in the sample. */
export interface Candidate {
  /** `hard` or `counted` when a check the judge answers failed, else null. Hard wins. */
  failed: "counted" | "hard" | null;
  item: CalibrationItem;
  /** `kind/expect`, such as `opener/crisis`. */
  stratum: string;
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** The sample id of one reply: setup, item, repeat, and exchange. */
export function sampleItemId(
  setupId: string,
  itemId: string,
  repeat: number,
  turn: number
): string {
  return `${setupId}:${itemId}:r${repeat}:t${turn}`;
}

function failureOf(
  item: ReportItem,
  assistantIndex: number,
  judged: readonly string[]
): Candidate["failed"] {
  const checks = item.turns[assistantIndex]?.checks ?? [];
  const failed = checks.filter(
    (check) => check.outcome === "fail" && judged.includes(check.id)
  );
  if (
    failed.some((check) =>
      (HARD_CHECK_IDS as readonly string[]).includes(check.id)
    )
  ) {
    return "hard";
  }
  return failed.some((check) =>
    (COUNTED_CHECK_IDS as readonly string[]).includes(check.id)
  )
    ? "counted"
    : null;
}

export interface Owners {
  /** The person whose Sage had the empty journal. */
  host: LoadedPerson;
  people: ReadonlyMap<string, LoadedPerson>;
}

/**
 * Every reply of one report item that could be sampled: the reply of an
 * opener or a fact question, or each reply of a conversation. A reply that
 * failed, was empty, or was not graded is left out, because there is nothing
 * to compare with.
 */
export function candidatesOfItem(
  setupId: string,
  item: ReportItem,
  source: Pick<SweepSource, "transcripts">,
  owners: Owners
): Candidate[] {
  const row = sourceRow(source, setupId, item);
  const owner = owners.people.get(item.person);
  if (row === null || owner === undefined || item.status !== "graded") {
    return [];
  }
  const sheetOwner = row.journal === "empty" ? owners.host : owner;
  const candidates: Candidate[] = [];
  for (const exchange of exchangesOf(row.turns)) {
    const reply = row.turns[exchange.assistantIndex];
    const message = row.turns[exchange.userIndex];
    if (
      reply === undefined ||
      message === undefined ||
      reply.error !== undefined ||
      reply.text.trim().length === 0
    ) {
      continue;
    }
    const base: CalibrationItem = {
      checks: [],
      context: { toolCalls: reply.toolCalls },
      expect: "venting",
      id: sampleItemId(setupId, item.itemId, item.repeat, exchange.n),
      itemId: item.itemId,
      journal: row.journal,
      kind: row.kind,
      message: message.text,
      person: item.person,
      repeat: item.repeat,
      reply: reply.text,
      rubric: [],
      setupId,
      turn: exchange.n,
    };
    const labels = labelsOfSample(base, owner);
    const applied = checksFor(labels);
    const ids = appliedIdsOf(applied);
    const prior = row.turns
      .slice(0, exchange.userIndex)
      .map((turn) => ({ role: turn.role, text: turn.text }));
    candidates.push({
      failed: failureOf(item, exchange.assistantIndex, ids.checks),
      item: {
        ...base,
        checks: ids.checks,
        context: {
          factSheet: factSheetOf(sheetOwner),
          ...(prior.length === 0 ? {} : { priorTurns: prior }),
          toolCalls: reply.toolCalls,
        },
        expect: labels.expect,
        rubric: ids.rubric,
      },
      stratum: `${row.kind}/${labels.expect}`,
    });
  }
  return candidates;
}

/** Every candidate of a finished sweep, in a fixed order. */
export function candidatesOf(source: SweepSource, owners: Owners): Candidate[] {
  const all: Candidate[] = [];
  for (const report of source.reports) {
    for (const item of report.items) {
      if ((REPLY_ITEM_KINDS as readonly string[]).includes(item.kind)) {
        all.push(...candidatesOfItem(report.setupId, item, source, owners));
      }
    }
  }
  return all.sort((a, b) => compareText(a.item.id, b.item.id));
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

interface StratumQueue {
  cursor: number;
  /** One queue for each setup, so one setup does not fill the stratum. */
  setups: Candidate[][];
}

/**
 * Picks up to `count` candidates, one stratum after another, so each kind of
 * message is represented before any is repeated. Inside a stratum it goes
 * through the setups in turn. The order within each setup is shuffled by
 * `random`, and strata and setups are visited in sorted order, so the same
 * seed always picks the same candidates.
 */
export function pickStratified(
  pool: readonly Candidate[],
  count: number,
  random: () => number
): Candidate[] {
  const strata = new Map<string, Map<string, Candidate[]>>();
  for (const candidate of pool) {
    const bySetup =
      strata.get(candidate.stratum) ?? new Map<string, Candidate[]>();
    const list = bySetup.get(candidate.item.setupId) ?? [];
    list.push(candidate);
    bySetup.set(candidate.item.setupId, list);
    strata.set(candidate.stratum, bySetup);
  }
  const queues: StratumQueue[] = [...strata.keys()]
    .sort(compareText)
    .map((stratum) => {
      const bySetup = strata.get(stratum) as Map<string, Candidate[]>;
      return {
        cursor: 0,
        setups: [...bySetup.keys()].sort(compareText).map((setupId) =>
          shuffled(
            [...(bySetup.get(setupId) as Candidate[])].sort((a, b) =>
              compareText(a.item.id, b.item.id)
            ),
            random
          )
        ),
      };
    });
  const picked: Candidate[] = [];
  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= count) {
        break;
      }
      const taken = takeNext(queue);
      if (taken !== undefined) {
        picked.push(taken);
        progressed = true;
      }
    }
  }
  return picked;
}

function takeNext(queue: StratumQueue): Candidate | undefined {
  const { setups } = queue;
  for (let step = 0; step < setups.length; step += 1) {
    const index = (queue.cursor + step) % setups.length;
    const taken = setups[index]?.shift();
    if (taken !== undefined) {
      queue.cursor = index + 1;
      return taken;
    }
  }
  return undefined;
}

/**
 * The sample: every reply with a failed hard or counted check, unless there
 * are more than the size leaves room for, and passes for the rest. Failures
 * take at most three quarters of the sample, and hard failures come before
 * counted ones. Each group is stratified by kind and `expect`. The result is
 * shuffled, so the order of the sample says nothing about the setup or the
 * outcome.
 */
export function chooseSample(
  candidates: readonly Candidate[],
  size: number,
  seed: number
): Candidate[] {
  const random = seededRandom(seed);
  const hard = candidates.filter((candidate) => candidate.failed === "hard");
  const counted = candidates.filter(
    (candidate) => candidate.failed === "counted"
  );
  const passes = candidates.filter((candidate) => candidate.failed === null);
  const failing = hard.length + counted.length;
  const passTarget = Math.min(
    passes.length,
    Math.max(Math.ceil(size * PASS_SHARE), size - failing)
  );
  const failTarget = Math.min(failing, Math.max(0, size - passTarget));
  const chosenHard = pickStratified(hard, failTarget, random);
  const chosenCounted = pickStratified(
    counted,
    failTarget - chosenHard.length,
    random
  );
  const chosenPasses = pickStratified(passes, passTarget, random);
  return shuffled([...chosenHard, ...chosenCounted, ...chosenPasses], random);
}

// ---------------------------------------------------------------------------
// Building and writing
// ---------------------------------------------------------------------------

export interface SampleOptions {
  seed: number;
  size: number;
}

export interface SampleDeps {
  dirs?: SweepDirs;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
}

/** Reads the sweep and the people it names, and picks the sample. Throws a readable error when the sweep is not finished. */
export async function buildSample(
  sweepId: string,
  options: SampleOptions,
  deps: SampleDeps = {}
): Promise<CalibrationSample> {
  const source = loadSweepSource(sweepId, deps.dirs ?? defaultSweepDirs());
  const load = deps.loadPerson ?? loadPerson;
  const ids = new Set<string>();
  for (const report of source.reports) {
    for (const item of report.items) {
      if ((REPLY_ITEM_KINDS as readonly string[]).includes(item.kind)) {
        ids.add(item.person);
      }
    }
  }
  const people = new Map<string, LoadedPerson>();
  await Promise.all(
    [...ids].map(async (id) => {
      people.set(id, await load(id));
    })
  );
  const host = await loadEmptyJournalPerson(load);
  const candidates = candidatesOf(source, { host, people });
  if (candidates.length === 0) {
    throw new Error(
      `Sweep ${sweepId} has no graded replies to sample. Run a sweep that sends openers or fact questions, and let it finish grading.`
    );
  }
  const chosen = chooseSample(candidates, options.size, options.seed);
  return parseCalibrationSample({
    items: chosen.map((candidate) => candidate.item),
    sampleId: sweepId,
    seed: options.seed,
    sweepId,
  });
}

/** Writes the sample to `<dir>/sample-<sweep id>.json`. Returns the path. */
export function writeSample(
  sample: CalibrationSample,
  dir = defaultCalibrationDir()
): string {
  const path = join(dir, sampleFileName(sample.sampleId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`);
  return path;
}

/** `40 replies: opener/crisis 6, opener/venting 9, ...` for the end of a run. */
export function describeSample(sample: CalibrationSample): string {
  const strata = new Map<string, number>();
  for (const item of sample.items) {
    const key = `${item.kind}/${item.expect}`;
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  const lines = [...strata.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, count]) => `${key} ${count}`);
  return `${sample.items.length} replies: ${lines.join(", ")}`;
}

const USAGE = `Usage: npm --prefix agent run calibration-sample -- <sweep id> [--size ${DEFAULT_SAMPLE_SIZE}] [--seed ${DEFAULT_SEED}]`;
const wholeNumberPattern = /^\d+$/u;

function numberOption(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!wholeNumberPattern.test(value) || Number(value) < 1) {
    throw new Error(`${name} needs a whole number of 1 or more.`);
  }
  return Number(value);
}

export interface ParsedArgs {
  options: SampleOptions;
  sweepId: string;
}

/** Reads the command line. Throws a readable error. */
export function parseSampleArgs(argv: readonly string[]): ParsedArgs {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      seed: { type: "string" },
      size: { type: "string" },
    },
  });
  const [sweepId, ...extra] = positionals;
  if (sweepId === undefined || extra.length > 0) {
    throw new Error(`Give one sweep id.\n${USAGE}`);
  }
  return {
    options: {
      seed: numberOption(values.seed, DEFAULT_SEED, "--seed"),
      size: numberOption(values.size, DEFAULT_SAMPLE_SIZE, "--size"),
    },
    sweepId,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseSampleArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const sample = await buildSample(parsed.sweepId, parsed.options);
    const path = writeSample(sample);
    console.log(`Wrote ${path}`);
    console.log(describeSample(sample));
    console.log(
      "Grade the replies in the viewer (make eval-viewer-dev). Each grade is a line in agent/evals/content/calibration/grades.jsonl."
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
