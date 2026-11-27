/**
 * Calibrating the judge against your own grades.
 *
 * The judge check proves the judge catches planted failures. Calibration asks
 * a wider question: on replies from real sweeps, does the judge agree with you?
 *
 * 1. `agent/scripts/eval/calibration-sample.ts` picks about 40 replies from a
 *    finished sweep and writes `agent/evals/content/calibration/sample-<sweep id>.json`.
 * 2. You grade them in the viewer. Each grade is one line of
 *    `agent/evals/content/calibration/grades.jsonl`.
 * 3. `agent/evals/calibration/agreement.eval.ts` grades the same replies with
 *    the judge the sweep names (`judge.model`), and this file compares the two.
 *
 * A check verdict is `true` when the reply passes it (nothing wrong), `false`
 * when it fails, and `null` when there is no verdict. That is the polarity of
 * the judge's own `pass`. A rubric score is a whole number from 1 to 5, or
 * `null`.
 *
 * For each rubric item the report gives exact agreement, agreement within one
 * point, and the quadratic-weighted kappa. For each check it counts:
 *
 * - hits: you failed it and the judge failed it
 * - misses: you failed it and the judge passed it
 * - false alarms: you passed it and the judge failed it
 *
 * Everything that touches the world (the people, the judge) is passed in, so
 * the tests run with made-up people and a mock judge.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defineEval } from "eve/evals";
import { z } from "zod";

import {
  type AppliedChecks,
  checksFor,
  GRADED_REPLY_RUBRIC_IDS,
  REPLY_COUNTED_CHECK_IDS,
  REPLY_HARD_CHECK_IDS,
  REPLY_SLIP_IDS,
  type ReplyItem,
} from "./checks.ts";
import { evalContentDir } from "./content.ts";
import { replyItemForTurn } from "./conversation-checks.ts";
import { conversationOfRow, replyBaseOf } from "./conversation-grade.ts";
import { type LoadedPerson, loadPerson } from "./dataset.ts";
import { formatFactSheet } from "./dream-judge-input.ts";
import { type Grader, sharedGrader } from "./grader.ts";
import { formatJournalContext } from "./judge-context.ts";
import { type EvalDefinition, guardedEvals } from "./pass.ts";
import { itemMetadata, makeItem, recordCheck } from "./record.ts";
import {
  gradeReply,
  itemOfRow,
  loadEmptyJournalPerson,
  type ReplyGradeResult,
} from "./reply-grade.ts";
import { type EarlierTurn, itemWithSearchCalls } from "./rubric.ts";
import {
  ENV_TODAY,
  EXPECTS,
  JOURNALS,
  judgeSettingsSchema,
  REPORT_SCHEMA_VERSION,
  type ReplyGrade,
  readPassEnv,
  SchemaError,
  TRANSCRIPT_KINDS,
  type TranscriptRow,
  toolCallSchema,
} from "./schema.ts";
import { readPassSweep } from "./setup.ts";

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const GRADES_FILE = "grades.jsonl";
export const CALIBRATION_REPORT_SUFFIX = ".calibration.json";

const SAMPLE_PREFIX = "sample-";
const SAMPLE_SUFFIX = ".json";
const lineBreakPattern = /\r?\n/u;

export function defaultCalibrationDir(): string {
  return evalContentDir("calibration");
}

/** `sample-<sweep id>.json` */
export function sampleFileName(sweepId: string): string {
  return `${SAMPLE_PREFIX}${sweepId}${SAMPLE_SUFFIX}`;
}

/** `<calibration id>.calibration.json` */
export function calibrationReportFileName(id: string): string {
  return `${id}${CALIBRATION_REPORT_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

/** The checks a human grades: the hard and counted checks and the slips the judge answers for a reply. */
export const CALIBRATED_CHECK_IDS = [
  ...REPLY_HARD_CHECK_IDS,
  ...REPLY_COUNTED_CHECK_IDS,
  ...REPLY_SLIP_IDS,
] as const;
export type CalibratedCheckId = (typeof CALIBRATED_CHECK_IDS)[number];

export const CALIBRATED_RUBRIC_IDS = GRADED_REPLY_RUBRIC_IDS;
export type CalibratedRubricId = (typeof CALIBRATED_RUBRIC_IDS)[number];

const text = z.string().trim().min(1, "Must not be empty.");

const turnTextSchema = z.strictObject({
  role: z.enum(["assistant", "user"]),
  text: z.string(),
});

/** One reply for you to grade, and what you need to grade it. */
export const calibrationItemSchema = z.strictObject({
  /** The checks that apply to this reply. You grade these and no others. */
  checks: z.array(z.enum(CALIBRATED_CHECK_IDS)),
  /** What you need to read the reply. */
  context: z
    .strictObject({
      factSheet: z.string().optional(),
      /** The visible turns before the person's message, in a conversation. */
      priorTurns: z.array(turnTextSchema).optional(),
      /** What Sage did before it replied, with the results. */
      toolCalls: z.array(toolCallSchema).optional(),
    })
    .optional(),
  expect: z.enum(EXPECTS),
  /** Unique in the sample: setup, item, repeat, and exchange. */
  id: text,
  /** The report item the reply is from, such as `engaged/opener/rent-panic`. */
  itemId: text,
  /** The journal the reply was written against. */
  journal: z.enum(JOURNALS).default("own"),
  kind: z.enum(TRANSCRIPT_KINDS),
  message: z.string(),
  person: text,
  repeat: z.number().int().min(1).default(1),
  reply: z.string(),
  /** The rubric items that apply to this reply. */
  rubric: z.array(z.enum(CALIBRATED_RUBRIC_IDS)),
  setupId: text,
  /** The 1-based exchange of a conversation. 1 for an opener or a question. */
  turn: z.number().int().min(1).default(1),
});
export type CalibrationItem = z.infer<typeof calibrationItemSchema>;

export const calibrationSampleSchema = z
  .strictObject({
    items: z.array(calibrationItemSchema),
    /** The seed that picked the sample. The same seed and sweep give the same sample. */
    sampleId: text,
    seed: z.number().int().optional(),
    /** The sweep the replies came from. */
    sweepId: text.optional(),
  })
  .superRefine((sample, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of sample.items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate id "${item.id}".`,
          path: ["items", index, "id"],
        });
      }
      seen.add(item.id);
    }
  });
export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;

function issuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    out +=
      typeof key === "number"
        ? `[${key}]`
        : `${out.length === 0 ? "" : "."}${String(key)}`;
  }
  return out.length === 0 ? "(top level)" : out;
}

function parseWith<S extends z.ZodType>(
  schema: S,
  input: unknown,
  label: string
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new SchemaError(
    label,
    result.error.issues.map(
      (issue) => `${issuePath(issue.path)}: ${issue.message}`
    )
  );
}

export function parseCalibrationSample(
  input: unknown,
  label = "calibration sample"
): CalibrationSample {
  return parseWith(calibrationSampleSchema, input, `Invalid ${label}`);
}

/** The ids of the samples in a folder, from the files `sample-<id>.json`. */
export function sampleIdsIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) => name.startsWith(SAMPLE_PREFIX) && name.endsWith(SAMPLE_SUFFIX)
    )
    .map((name) => name.slice(SAMPLE_PREFIX.length, -SAMPLE_SUFFIX.length))
    .sort();
}

/**
 * Every sample in the folder, or only the one for sweep `only`. Throws a
 * readable error when `only` has no sample.
 */
export function loadCalibrationSamples(
  dir: string,
  only?: string
): CalibrationSample[] {
  const ids = only === undefined ? sampleIdsIn(dir) : [only];
  return ids.map((id) => {
    const path = join(dir, sampleFileName(id));
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(
        `No calibration sample for ${id}: ${path} could not be read. Make one with npm --prefix agent run calibration-sample -- ${id}.`,
        { cause: error }
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${path} is not valid JSON.`, { cause: error });
    }
    return parseCalibrationSample(json, path);
  });
}

// ---------------------------------------------------------------------------
// Human grades
// ---------------------------------------------------------------------------

/** One line of `grades.jsonl`. `true` passes a check, `false` fails it, `null` is no verdict. */
export const humanGradeSchema = z.strictObject({
  checks: z
    .partialRecord(z.enum(CALIBRATED_CHECK_IDS), z.boolean().nullable())
    .default(() => ({})),
  gradedAt: z.string().default(""),
  grader: z.literal("human"),
  id: text,
  note: z.string().default(""),
  rubric: z
    .partialRecord(
      z.enum(CALIBRATED_RUBRIC_IDS),
      z.number().int().min(1).max(5).nullable()
    )
    .default(() => ({})),
  sampleId: text,
});
export type HumanGrade = z.infer<typeof humanGradeSchema>;

export function parseHumanGrade(
  input: unknown,
  label = "human grade"
): HumanGrade {
  return parseWith(humanGradeSchema, input, `Invalid ${label}`);
}

/** The key of a sample item in a grades map. */
export function gradeKey(sampleId: string, id: string): string {
  return `${sampleId}\u0000${id}`;
}

/**
 * The grades in `grades.jsonl`, by `gradeKey`. A later line for the same reply
 * replaces an earlier one, so a regrade is a new line. A missing file is no
 * grades. A bad line throws an error that names the file and the line, so a
 * typo cannot lose a grade without a word.
 */
export function loadHumanGrades(path: string): Map<string, HumanGrade> {
  const grades = new Map<string, HumanGrade>();
  if (!existsSync(path)) {
    return grades;
  }
  const lines = readFileSync(path, "utf8").split(lineBreakPattern);
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const where = `${path}:${offset + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${where} is not valid JSON.`, { cause: error });
    }
    const grade = parseHumanGrade(json, where);
    grades.set(gradeKey(grade.sampleId, grade.id), grade);
  }
  return grades;
}

/** Adds one grade as a line. The viewer's grading form and the tests use it. */
export function appendHumanGrade(path: string, grade: HumanGrade): void {
  const checked = parseHumanGrade(grade);
  appendFileSync(path, `${JSON.stringify(checked)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Rebuilding what the judge saw
// ---------------------------------------------------------------------------

type Owner = Pick<LoadedPerson, "empty" | "id" | "personCase">;

/** A transcript row with no turns: enough for the label lookups that read the item id, kind, and journal. */
function labelRow(item: CalibrationItem): TranscriptRow {
  return {
    ended: "done",
    itemId: item.itemId,
    journal: item.journal,
    kind: item.kind,
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
    simulatedUserFlags: [],
    turns: [],
  };
}

/**
 * The labels the judge reads for a reply, from the person's case: the opener's
 * for an opener, the question's for a fact question, and the conversation's
 * for a turn of a conversation (with the crisis turn from `case.yaml`). Throws
 * when the person no longer has the opener or conversation.
 */
export function labelsOfSample(item: CalibrationItem, owner: Owner): ReplyItem {
  const toolCalls = item.context?.toolCalls ?? [];
  const row = labelRow(item);
  if (item.kind === "conversation") {
    const conversation = conversationOfRow(row, owner);
    const journalEmpty = item.journal === "empty" || owner.empty;
    return itemWithSearchCalls(
      replyItemForTurn(
        replyBaseOf(conversation, journalEmpty),
        item.turn,
        conversation.crisis?.turn
      ),
      toolCalls
    );
  }
  return itemWithSearchCalls(itemOfRow(row, owner), toolCalls);
}

/** The fact sheet a person reads while grading: the cast and the timeline, without the journal. */
export function factSheetOf(owner: Owner): string {
  return formatFactSheet(owner);
}

/** The turns before a conversation reply, as the judge reads them. */
export function priorTurnsOf(item: CalibrationItem): EarlierTurn[] {
  return (item.context?.priorTurns ?? []).map((turn) => ({
    role: turn.role,
    text: turn.text,
  }));
}

/** The checks and rubric items of a reply that apply, as the sample lists them. */
export function appliedIdsOf(applied: AppliedChecks): {
  checks: CalibratedCheckId[];
  rubric: CalibratedRubricId[];
} {
  return {
    checks: [...applied.hard, ...applied.counted, ...applied.slips],
    rubric: applied.rubric.flatMap((ask) =>
      ask.notApplicable === null ? [ask.id] : []
    ),
  };
}

// ---------------------------------------------------------------------------
// The judge's side
// ---------------------------------------------------------------------------

/** What the judge said: a pass or fail for each check, and a level for each rubric item. */
export interface JudgeVerdicts {
  checks: Partial<Record<CalibratedCheckId, boolean | null>>;
  rubric: Partial<Record<CalibratedRubricId, number | null>>;
}

/** `journal-right` fails when the judge lists a journal error, whatever its verdict says. */
export function checkVerdictOf(
  grade: ReplyGrade,
  id: CalibratedCheckId
): boolean | null {
  if (id === "journal-right" && grade.journalErrors.length > 0) {
    return false;
  }
  const verdict = [...grade.hard, ...grade.counted, ...grade.slips].find(
    (entry) => entry.id === id
  );
  return verdict?.pass ?? null;
}

export function rubricLevelOf(
  grade: ReplyGrade,
  id: CalibratedRubricId
): number | null {
  return grade.rubric.find((entry) => entry.id === id)?.level ?? null;
}

export function judgeVerdictsOf(
  grade: ReplyGrade,
  item: Pick<CalibrationItem, "checks" | "rubric">
): JudgeVerdicts {
  return {
    checks: Object.fromEntries(
      item.checks.map((id) => [id, checkVerdictOf(grade, id)])
    ),
    rubric: Object.fromEntries(
      item.rubric.map((id) => [id, rubricLevelOf(grade, id)])
    ),
  };
}

// ---------------------------------------------------------------------------
// Comparing the two
// ---------------------------------------------------------------------------

/** A pair with both sides answered. */
function answered<T>(
  pair: { human: T | null; judge: T | null } | undefined
): pair is { human: T; judge: T } {
  return pair !== undefined && pair.human !== null && pair.judge !== null;
}

const pairSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({ human: value.nullable(), judge: value.nullable() });

/** What you and the judge each said about one reply. Only what both could have said is here. */
export const itemComparisonSchema = z.strictObject({
  checks: z.record(z.string(), pairSchema(z.boolean())),
  /** The id of the sample item. */
  id: text,
  rubric: z.record(z.string(), pairSchema(z.number().int().min(1).max(5))),
  sampleId: text,
});
export type ItemComparison = z.infer<typeof itemComparisonSchema>;

/**
 * Pairs your verdicts with the judge's for the checks and rubric items that
 * the sample lists for the reply, and that you graded.
 */
export function compareItem(
  item: CalibrationItem,
  sampleId: string,
  human: HumanGrade,
  judge: JudgeVerdicts
): ItemComparison {
  const checks: ItemComparison["checks"] = {};
  for (const id of item.checks) {
    if (id in human.checks) {
      checks[id] = {
        human: human.checks[id] ?? null,
        judge: judge.checks[id] ?? null,
      };
    }
  }
  const rubric: ItemComparison["rubric"] = {};
  for (const id of item.rubric) {
    if (id in human.rubric) {
      rubric[id] = {
        human: human.rubric[id] ?? null,
        judge: judge.rubric[id] ?? null,
      };
    }
  }
  return { checks, id: item.id, rubric, sampleId };
}

export const RUBRIC_LEVELS = 5;

/**
 * Quadratic-weighted kappa between two raters scoring 1 to 5. 1 is perfect
 * agreement, 0 is no better than chance, and below 0 is worse than chance.
 * A near miss costs little and a far miss costs a lot: the weight of a pair is
 * the squared distance over the largest squared distance.
 *
 * Null when there are no pairs, or when the chance disagreement is zero
 * because both raters gave the same single score throughout, which leaves
 * kappa undefined. When only one rater gave one score throughout, or the two
 * gave different single scores, the chance disagreement equals the observed
 * one, so kappa is 0.
 */
export function quadraticWeightedKappa(
  pairs: readonly (readonly [number, number])[]
): number | null {
  const count = pairs.length;
  if (count === 0) {
    return null;
  }
  const first = new Array<number>(RUBRIC_LEVELS).fill(0);
  const second = new Array<number>(RUBRIC_LEVELS).fill(0);
  const weight = (a: number, b: number): number =>
    ((a - b) / (RUBRIC_LEVELS - 1)) ** 2;
  let observed = 0;
  for (const [a, b] of pairs) {
    first[a - 1] = (first[a - 1] ?? 0) + 1;
    second[b - 1] = (second[b - 1] ?? 0) + 1;
    observed += weight(a, b);
  }
  let expected = 0;
  for (let i = 0; i < RUBRIC_LEVELS; i += 1) {
    for (let j = 0; j < RUBRIC_LEVELS; j += 1) {
      expected += (((first[i] ?? 0) * (second[j] ?? 0)) / count) * weight(i, j);
    }
  }
  return expected === 0 ? null : 1 - observed / expected;
}

export const rubricAgreementSchema = z.strictObject({
  /** The share of replies where both gave the same score. */
  exact: z.number().min(0).max(1).nullable(),
  id: z.enum(CALIBRATED_RUBRIC_IDS),
  /** Quadratic-weighted kappa. Null when it is undefined. */
  kappa: z.number().nullable(),
  /** The mean of judge minus human. Positive means the judge scores higher. */
  meanDiff: z.number().nullable(),
  /** Replies with a score from both. */
  n: z.number().int().min(0),
  /** The share of replies where the two scores are within one point. */
  within1: z.number().min(0).max(1).nullable(),
});
export type RubricAgreement = z.infer<typeof rubricAgreementSchema>;

export const checkAgreementSchema = z.strictObject({
  /** The share of replies where both said the same, pass or fail. */
  agreement: z.number().min(0).max(1).nullable(),
  /** You passed it and the judge failed it. */
  falseAlarms: z.number().int().min(0),
  /** You failed it and the judge failed it. */
  hits: z.number().int().min(0),
  id: z.enum(CALIBRATED_CHECK_IDS),
  /** You failed it and the judge passed it. */
  misses: z.number().int().min(0),
  /** Replies with a verdict from both. */
  n: z.number().int().min(0),
  /** You passed it and the judge passed it. */
  passes: z.number().int().min(0),
});
export type CheckAgreement = z.infer<typeof checkAgreementSchema>;

function share(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

/** The agreement of one rubric item over the comparisons that have both scores. */
export function rubricAgreement(
  id: CalibratedRubricId,
  comparisons: readonly ItemComparison[]
): RubricAgreement {
  const pairs: [number, number][] = [];
  for (const comparison of comparisons) {
    const pair = comparison.rubric[id];
    if (answered(pair)) {
      pairs.push([pair.human, pair.judge]);
    }
  }
  const exact = pairs.filter(([human, judge]) => human === judge).length;
  const near = pairs.filter(
    ([human, judge]) => Math.abs(human - judge) <= 1
  ).length;
  const diff = pairs.reduce((sum, [human, judge]) => sum + (judge - human), 0);
  return {
    exact: share(exact, pairs.length),
    id,
    kappa: quadraticWeightedKappa(pairs),
    meanDiff: pairs.length === 0 ? null : diff / pairs.length,
    n: pairs.length,
    within1: share(near, pairs.length),
  };
}

/** Hits, misses, and false alarms of one check over the comparisons that have both verdicts. */
export function checkAgreement(
  id: CalibratedCheckId,
  comparisons: readonly ItemComparison[]
): CheckAgreement {
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let passes = 0;
  for (const comparison of comparisons) {
    const pair = comparison.checks[id];
    if (!answered(pair)) {
      continue;
    }
    if (pair.human && pair.judge) {
      passes += 1;
    } else if (pair.human) {
      falseAlarms += 1;
    } else if (pair.judge) {
      misses += 1;
    } else {
      hits += 1;
    }
  }
  const n = hits + misses + falseAlarms + passes;
  return {
    agreement: share(hits + passes, n),
    falseAlarms,
    hits,
    id,
    misses,
    n,
    passes,
  };
}

export interface Agreement {
  checks: CheckAgreement[];
  rubric: RubricAgreement[];
}

/** Agreement over all the comparisons. An item with no comparison for an id adds nothing to it. Ids no reply used are left out. */
export function aggregateAgreement(
  comparisons: readonly ItemComparison[]
): Agreement {
  return {
    checks: CALIBRATED_CHECK_IDS.map((id) =>
      checkAgreement(id, comparisons)
    ).filter((entry) => entry.n > 0),
    rubric: CALIBRATED_RUBRIC_IDS.map((id) =>
      rubricAgreement(id, comparisons)
    ).filter((entry) => entry.n > 0),
  };
}

export const disagreementSchema = z.strictObject({
  human: z.string(),
  id: z.string(),
  /** The sample item. */
  item: z.string(),
  judge: z.string(),
  kind: z.enum(["check", "rubric"]),
});
export type Disagreement = z.infer<typeof disagreementSchema>;

const RUBRIC_GAP = 2;

function verdictWord(value: boolean | null): string {
  if (value === null) {
    return "none";
  }
  return value ? "pass" : "fail";
}

/** Where the two differ in a way that matters: a check that went the other way, or a score two or more points apart. */
export function disagreementsOf(
  comparisons: readonly ItemComparison[]
): Disagreement[] {
  const found: Disagreement[] = [];
  for (const comparison of comparisons) {
    for (const [id, pair] of Object.entries(comparison.checks)) {
      if (answered(pair) && pair.human !== pair.judge) {
        found.push({
          human: verdictWord(pair.human),
          id,
          item: comparison.id,
          judge: verdictWord(pair.judge),
          kind: "check",
        });
      }
    }
    for (const [id, pair] of Object.entries(comparison.rubric)) {
      if (answered(pair) && Math.abs(pair.human - pair.judge) >= RUBRIC_GAP) {
        found.push({
          human: String(pair.human),
          id,
          item: comparison.id,
          judge: String(pair.judge),
          kind: "rubric",
        });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const calibrationReportSchema = z.strictObject({
  checks: z.array(checkAgreementSchema),
  costUsd: z.number().min(0),
  disagreements: z.array(disagreementSchema),
  generatedAt: z.string(),
  /** Replies counted: you graded them, and the judge answered. */
  items: z.strictObject({
    compared: z.number().int().min(0),
    humanGraded: z.number().int().min(0),
    notGraded: z.number().int().min(0),
  }),
  judge: judgeSettingsSchema,
  /** The judge rubric hash of the run. */
  rubric: text.optional(),
  rubricAgreement: z.array(rubricAgreementSchema),
  /** The ids of the samples the grades came from. */
  samples: z.array(text),
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  /** The id of the calibration run. */
  sweepId: text,
});
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

export function parseCalibrationReport(
  input: unknown,
  label = "calibration report"
): CalibrationReport {
  return parseWith(calibrationReportSchema, input, `Invalid ${label}`);
}

export interface ReportInput {
  comparisons: readonly ItemComparison[];
  costUsd: number;
  generatedAt: string;
  humanGraded: number;
  judge: { model: string };
  notGraded: number;
  rubricHash?: string;
  samples: readonly string[];
  sweepId: string;
}

export function buildCalibrationReport(input: ReportInput): CalibrationReport {
  const agreement = aggregateAgreement(input.comparisons);
  return parseCalibrationReport({
    checks: agreement.checks,
    costUsd: input.costUsd,
    disagreements: disagreementsOf(input.comparisons),
    generatedAt: input.generatedAt,
    items: {
      compared: input.comparisons.length,
      humanGraded: input.humanGraded,
      notGraded: input.notGraded,
    },
    judge: input.judge,
    ...(input.rubricHash === undefined ? {} : { rubric: input.rubricHash }),
    rubricAgreement: agreement.rubric,
    samples: [...input.samples],
    schemaVersion: REPORT_SCHEMA_VERSION,
    sweepId: input.sweepId,
  });
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function decimal(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

/** The report as lines for the end of a run. */
export function describeCalibration(report: CalibrationReport): string[] {
  const lines = [
    `Calibration with ${report.judge.model}: ${report.items.compared} repl${report.items.compared === 1 ? "y" : "ies"} compared, ${report.items.humanGraded} graded by you, ${report.items.notGraded} not graded by the judge.`,
  ];
  for (const entry of report.rubricAgreement) {
    lines.push(
      `  ${entry.id}: exact ${percent(entry.exact)}, within 1 ${percent(entry.within1)}, kappa ${decimal(entry.kappa)} (${entry.n})`
    );
  }
  for (const entry of report.checks) {
    lines.push(
      `  ${entry.id}: ${entry.hits} hit${entry.hits === 1 ? "" : "s"}, ${entry.misses} miss${entry.misses === 1 ? "" : "es"}, ${entry.falseAlarms} false alarm${entry.falseAlarms === 1 ? "" : "s"} (${entry.n})`
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

export const CALIBRATION_CHECK_ID = "calibration";

export interface CalibrationEvalDeps {
  /** The folder with the samples and `grades.jsonl`. Defaults to `agent/evals/content/calibration`. */
  dir?: string;
  env?: Env;
  grader?: Grader;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
  /** Limits the run to one sample. Defaults to the sweep's `compare`. */
  only?: string;
}

/** A reply to regrade, with your grade. */
export interface GradedSampleItem {
  grade: HumanGrade;
  item: CalibrationItem;
  sampleId: string;
}

/** Every sampled reply you graded, in sample order. A grade for a reply the sample no longer has is left out. */
export function gradedItems(
  samples: readonly CalibrationSample[],
  grades: ReadonlyMap<string, HumanGrade>
): GradedSampleItem[] {
  return samples.flatMap((sample) =>
    sample.items.flatMap((item) => {
      const grade = grades.get(gradeKey(sample.sampleId, item.id));
      return grade === undefined
        ? []
        : [{ grade, item, sampleId: sample.sampleId }];
    })
  );
}

/** What the judge is asked about a sampled reply. Throws when the person no longer has the opener or conversation. */
export async function regradeSampleItem(
  grader: Grader,
  item: CalibrationItem,
  contexts: { host: LoadedPerson; owner: LoadedPerson; today?: string }
): Promise<{ applied: AppliedChecks; result: ReplyGradeResult }> {
  const labels = labelsOfSample(item, contexts.owner);
  const source = item.journal === "empty" ? contexts.host : contexts.owner;
  const context = formatJournalContext(source, { today: contexts.today });
  const result = await gradeReply(grader, {
    context,
    earlier: priorTurnsOf(item),
    item: labels,
    label: `calibration ${item.id}`,
    message: item.message,
    reply: item.reply,
    toolCalls: item.context?.toolCalls ?? [],
  });
  return { applied: checksFor(labels), result };
}

/**
 * One eval for each sampled reply you graded. Each one asks the judge about
 * the reply, the way the real grade pass does, and records one soft score,
 * `soft:calibration`, with the comparison in its metadata. The runner turns
 * those into the report. A reply the judge cannot answer is "not graded".
 */
export function calibrationEvals(
  deps: CalibrationEvalDeps = {}
): Promise<EvalDefinition | EvalDefinition[]> {
  const env = deps.env ?? process.env;
  return guardedEvals(
    "calibration",
    async () => {
      // eve imports every eval file for every pass, so a pass that is not
      // the calibration sweep must not read the samples or load a person.
      const sweep = readPassSweep(env);
      if (!sweep.tests.includes("calibration")) {
        return [];
      }
      const dir = deps.dir ?? defaultCalibrationDir();
      const only = deps.only ?? sweep.compare;
      const samples = loadCalibrationSamples(dir, only);
      const graded = gradedItems(
        samples,
        loadHumanGrades(join(dir, GRADES_FILE))
      );
      const load = deps.loadPerson ?? loadPerson;
      const people = new Map<string, LoadedPerson>();
      await Promise.all(
        [...new Set(graded.map((entry) => entry.item.person))].map(
          async (id) => {
            people.set(id, await load(id));
          }
        )
      );
      const host = graded.some((entry) => entry.item.journal === "empty")
        ? await loadEmptyJournalPerson(load)
        : undefined;
      const today = readPassEnv(env).today ?? env[ENV_TODAY];
      return graded.flatMap((entry) => {
        const owner = people.get(entry.item.person);
        return owner === undefined
          ? []
          : [
              calibrationEval(entry, {
                deps,
                host: host ?? owner,
                owner,
                today,
              }),
            ];
      });
    },
    "No calibration to run. Use make eval SWEEP=calibration, after you grade a sample in the viewer, so agent/evals/content/calibration/grades.jsonl has lines."
  );
}

function calibrationEval(
  entry: GradedSampleItem,
  shared: {
    deps: CalibrationEvalDeps;
    host: LoadedPerson;
    owner: LoadedPerson;
    today: string | undefined;
  }
): EvalDefinition {
  const { item, grade, sampleId } = entry;
  const ref = makeItem(
    { itemId: item.itemId, kind: item.kind, person: item.person },
    item.setupId,
    item.repeat
  );
  return defineEval({
    description: `calibration ${sampleId} ${item.id}`,
    metadata: itemMetadata(ref),
    tags: ["calibration"],
    async test(t) {
      const { result } = await regradeSampleItem(
        shared.deps.grader ?? sharedGrader(),
        item,
        { host: shared.host, owner: shared.owner, today: shared.today }
      );
      if (!result.ok) {
        recordCheck(t, ref, {
          checkId: CALIBRATION_CHECK_ID,
          extra: {
            calibrationId: item.id,
            judgeModel: result.model,
            rubric: result.rubric,
            sampleId,
          },
          notGraded: true,
          reason: result.reason,
          tier: "soft",
        });
        return;
      }
      const comparison = compareItem(
        item,
        sampleId,
        grade,
        judgeVerdictsOf(result.grade, item)
      );
      const asked =
        Object.keys(comparison.checks).length +
        Object.keys(comparison.rubric).length;
      const agreeing =
        Object.values(comparison.checks).filter(
          (pair) => pair.human === pair.judge
        ).length +
        Object.values(comparison.rubric).filter(
          (pair) => pair.human === pair.judge
        ).length;
      recordCheck(t, ref, {
        checkId: CALIBRATION_CHECK_ID,
        extra: {
          calibrationId: item.id,
          comparison,
          judgeCallId: result.callId,
          judgeCostUsd: result.costUsd,
          judgeModel: result.model,
          rubric: result.rubric,
          sampleId,
        },
        reason: `${agreeing} of ${asked} verdicts match yours.`,
        score: asked === 0 ? 1 : agreeing / asked,
        tier: "soft",
      });
    },
  });
}
