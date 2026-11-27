import type { ParseOutcome } from "./sweep-types.ts";

// The grading form reads a calibration sample, written by
// agent/scripts/eval/calibration-sample.ts, and writes one line of
// grades.jsonl for each item you grade. The viewer is a separate package, so
// these types are its own copy of those shapes. The readers are tolerant:
// fields they do not know are ignored, and a missing optional field is filled
// in. The sample's shape is:
//
//   { sampleId, items: [{ id, setupId, itemId, person, kind, expect, message,
//                         reply, context?, checks: [checkId], rubric: [rubricId] }] }

export const sampleFilePattern = /^sample-[A-Za-z0-9._-]+\.json$/u;
export const gradesFileName = "grades.jsonl";
export const maxNoteLength = 5000;

export const rubricLevels = [1, 2, 3, 4, 5] as const;

/** One reply to grade. `context` is free-form: the conversation so far, a fact sheet, a journal excerpt. */
export interface CalibrationItem {
  /** The check ids to grade. */
  checks: string[];
  context?: Record<string, unknown>;
  expect: string;
  /** Unique within the sample. */
  id: string;
  itemId: string;
  kind: string;
  message: string;
  person: string;
  reply: string;
  /** The rubric ids to score. */
  rubric: string[];
  setupId: string;
}

export interface CalibrationSample {
  items: CalibrationItem[];
  sampleId: string;
}

/** `true` passes, `false` fails, and `null` is N/A. A check you have not answered has no key. */
export type CheckGrade = boolean | null;

/** 1 to 5, and `null` is N/A. A score you have not answered has no key. */
export type RubricGrade = number | null;

/** What you answered for one item. */
export interface GradeDraft {
  checks: Record<string, CheckGrade>;
  note: string;
  rubric: Record<string, RubricGrade>;
}

/** One line of grades.jsonl. */
export interface HumanGrade extends GradeDraft {
  gradedAt: string;
  grader: "human";
  id: string;
  sampleId: string;
}

export type ItemState = "done" | "empty" | "started";

export interface SampleProgress {
  done: number;
  started: number;
  total: number;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function emptyDraft(): GradeDraft {
  return { checks: {}, note: "", rubric: {} };
}

/** A name for a context key: `factSheet` reads `Fact sheet`. */
export function contextLabel(key: string): string {
  const spaced = key
    .replace(/[-_]+/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.length === 0
    ? key
    : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

export interface ContextTurn {
  role: string;
  text: string;
}

/** Reads a list of `{ role, text }` messages, such as the conversation so far. Anything else gives `undefined`. */
export function contextTurns(value: unknown): ContextTurn[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return;
  }
  const turns: ContextTurn[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      return;
    }
    const role = textOf(entry.role);
    const text = textOf(entry.text) ?? textOf(entry.content);
    if (role === undefined || text === undefined) {
      return;
    }
    turns.push({ role, text });
  }
  return turns;
}

function readItem(value: unknown, index: number): CalibrationItem | string {
  if (!isObject(value)) {
    return `items[${index}]: expected an object.`;
  }
  const id = textOf(value.id);
  if (id === undefined || id.length === 0) {
    return `items[${index}].id: expected text.`;
  }
  return {
    checks: textList(value.checks),
    context: isObject(value.context) ? value.context : undefined,
    expect: textOf(value.expect) ?? "",
    id,
    itemId: textOf(value.itemId) ?? "",
    kind: textOf(value.kind) ?? "",
    message: textOf(value.message) ?? "",
    person: textOf(value.person) ?? "",
    reply: textOf(value.reply) ?? "",
    rubric: textList(value.rubric),
    setupId: textOf(value.setupId) ?? "",
  };
}

export function parseCalibrationSample(
  raw: string
): ParseOutcome<CalibrationSample> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", message: "The file is not valid JSON." };
  }
  if (!isObject(json)) {
    return { kind: "invalid", message: "The sample: expected an object." };
  }
  const sampleId = textOf(json.sampleId);
  if (sampleId === undefined || sampleId.length === 0) {
    return { kind: "invalid", message: "sampleId: expected text." };
  }
  if (!Array.isArray(json.items)) {
    return { kind: "invalid", message: "items: expected a list." };
  }
  const items: CalibrationItem[] = [];
  const seen = new Set<string>();
  for (const [index, value] of json.items.entries()) {
    const item = readItem(value, index);
    if (typeof item === "string") {
      return { kind: "invalid", message: item };
    }
    if (seen.has(item.id)) {
      return {
        kind: "invalid",
        message: `items[${index}].id: "${item.id}" is used twice.`,
      };
    }
    seen.add(item.id);
    items.push(item);
  }
  return { kind: "ok", value: { items, sampleId } };
}

function readChecks(value: unknown): Record<string, CheckGrade> {
  const checks: Record<string, CheckGrade> = {};
  if (isObject(value)) {
    for (const [key, grade] of Object.entries(value)) {
      if (typeof grade === "boolean" || grade === null) {
        checks[key] = grade;
      }
    }
  }
  return checks;
}

function isLevel(value: unknown): value is number {
  return (
    typeof value === "number" && rubricLevels.some((level) => level === value)
  );
}

function readRubric(value: unknown): Record<string, RubricGrade> {
  const rubric: Record<string, RubricGrade> = {};
  if (isObject(value)) {
    for (const [key, grade] of Object.entries(value)) {
      if (isLevel(grade) || grade === null) {
        rubric[key] = grade;
      }
    }
  }
  return rubric;
}

/** Reads one line of grades.jsonl. A line that is not a human grade gives `undefined`. */
export function parseGradeLine(line: string): HumanGrade | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(json)) {
    return;
  }
  const sampleId = textOf(json.sampleId);
  const id = textOf(json.id);
  if (
    sampleId === undefined ||
    id === undefined ||
    (json.grader !== undefined && json.grader !== "human")
  ) {
    return;
  }
  return {
    checks: readChecks(json.checks),
    gradedAt: textOf(json.gradedAt) ?? "",
    grader: "human",
    id,
    note: textOf(json.note) ?? "",
    rubric: readRubric(json.rubric),
    sampleId,
  };
}

/** Every human grade in the file's text. Lines that do not read are skipped. */
export function parseGrades(raw: string): HumanGrade[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => parseGradeLine(line) ?? []);
}

/** The grades of one sample, by item id. A later line wins. */
export function gradesBySample(
  grades: readonly HumanGrade[],
  sampleId: string
): Map<string, HumanGrade> {
  const byId = new Map<string, HumanGrade>();
  for (const grade of grades) {
    if (grade.sampleId === sampleId) {
      byId.set(grade.id, grade);
    }
  }
  return byId;
}

/** One line of text for a grade, with the keys in a fixed order. */
export function serializeGrade(grade: HumanGrade): string {
  // biome-ignore assist/source/useSortedKeys: the file's lines read sampleId, id, grader, checks, rubric, note, gradedAt
  return JSON.stringify({
    sampleId: grade.sampleId,
    id: grade.id,
    grader: "human",
    checks: grade.checks,
    rubric: grade.rubric,
    note: grade.note,
    gradedAt: grade.gradedAt,
  });
}

/**
 * Puts a grade in the file's text. The line for the same sample and item is
 * replaced where it stands, and the grade is added at the end when there is
 * none. Every other line is kept exactly as it was, including lines this
 * viewer cannot read.
 */
export function upsertGradeText(raw: string, grade: HumanGrade): string {
  const next = serializeGrade(grade);
  const kept: string[] = [];
  let replaced = false;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const existing = parseGradeLine(line);
    const same =
      existing !== undefined &&
      existing.sampleId === grade.sampleId &&
      existing.id === grade.id;
    if (!same) {
      kept.push(line);
    } else if (!replaced) {
      // The first line for the item takes the new grade. A repeat is dropped.
      kept.push(next);
      replaced = true;
    }
  }
  if (!replaced) {
    kept.push(next);
  }
  return `${kept.join("\n")}\n`;
}

/** The draft an item starts from: its saved grade, or nothing. */
export function draftFromGrade(grade: HumanGrade | undefined): GradeDraft {
  return grade === undefined
    ? emptyDraft()
    : {
        checks: { ...grade.checks },
        note: grade.note,
        rubric: { ...grade.rubric },
      };
}

/** Done when every check and rubric id has an answer, N/A included. Started when anything has one. */
export function itemState(
  item: Pick<CalibrationItem, "checks" | "rubric">,
  draft: GradeDraft | undefined
): ItemState {
  if (draft === undefined) {
    return "empty";
  }
  const answered =
    Object.keys(draft.checks).length +
    Object.keys(draft.rubric).length +
    (draft.note.trim().length > 0 ? 1 : 0);
  if (answered === 0) {
    return "empty";
  }
  const complete =
    item.checks.every((id) => Object.hasOwn(draft.checks, id)) &&
    item.rubric.every((id) => Object.hasOwn(draft.rubric, id));
  return complete ? "done" : "started";
}

/** Counts the items you have finished and started. `drafts` is by item id. */
export function sampleProgress(
  sample: CalibrationSample,
  drafts: Readonly<Record<string, GradeDraft | undefined>>
): SampleProgress {
  const progress: SampleProgress = {
    done: 0,
    started: 0,
    total: sample.items.length,
  };
  for (const item of sample.items) {
    const state = itemState(
      item,
      Object.hasOwn(drafts, item.id) ? drafts[item.id] : undefined
    );
    if (state === "done") {
      progress.done += 1;
    } else if (state === "started") {
      progress.started += 1;
    }
  }
  return progress;
}

/** What the form sends for one item. */
export interface GradeInput extends GradeDraft {
  id: string;
}

export type GradeCheck =
  | { grade: Omit<HumanGrade, "gradedAt">; ok: true }
  | { ok: false; reason: string };

/** The answers of one kind, or the reason one of them is not allowed. */
function validateAnswers<T>(
  value: unknown,
  allowedKeys: readonly string[],
  isAnswer: (answer: unknown) => answer is T,
  keyName: string,
  answerName: string
): Record<string, T> | string {
  const answers: Record<string, T> = {};
  for (const [key, answer] of Object.entries(isObject(value) ? value : {})) {
    if (!allowedKeys.includes(key)) {
      return `"${key}" is not ${keyName}.`;
    }
    if (!isAnswer(answer)) {
      return `"${key}" must be ${answerName}.`;
    }
    answers[key] = answer;
  }
  return answers;
}

/**
 * Checks an input against its sample. The item must be in the sample, each key
 * must be one of the item's own check or rubric ids, and each value must be
 * pass, fail, or N/A for a check and 1 to 5 or N/A for a rubric item.
 */
export function validateGradeInput(
  sample: CalibrationSample,
  input: unknown
): GradeCheck {
  if (!isObject(input)) {
    return { ok: false, reason: "The grade is not an object." };
  }
  const id = textOf(input.id);
  const item = sample.items.find((candidate) => candidate.id === id);
  if (id === undefined || item === undefined) {
    return { ok: false, reason: "The sample has no item with that id." };
  }
  const checks = validateAnswers<CheckGrade>(
    input.checks,
    item.checks,
    (value): value is CheckGrade =>
      typeof value === "boolean" || value === null,
    "a check of this item",
    "pass, fail, or N/A"
  );
  if (typeof checks === "string") {
    return { ok: false, reason: checks };
  }
  const rubric = validateAnswers<RubricGrade>(
    input.rubric,
    item.rubric,
    (value): value is RubricGrade => isLevel(value) || value === null,
    "a rubric item of this item",
    "1 to 5 or N/A"
  );
  if (typeof rubric === "string") {
    return { ok: false, reason: rubric };
  }
  const note = typeof input.note === "string" ? input.note : "";
  if (note.length > maxNoteLength) {
    return {
      ok: false,
      reason: `The note is over ${maxNoteLength} characters.`,
    };
  }
  return {
    grade: {
      checks,
      grader: "human",
      id: item.id,
      note,
      rubric,
      sampleId: sample.sampleId,
    },
    ok: true,
  };
}
