/**
 * The judge check.
 *
 * A small labeled set that proves the judge catches what it should before a
 * sweep spends hours on local generation. It has two halves.
 *
 * Dream half. Each item is a journal entry, what Dream wrote from it, and the
 * verdicts we expect: is there a severe unsupported claim, and is there any
 * other unsupported claim. Some items are written to fail one check. The rest
 * are clean entries that a good summary handles. Files live in
 * `agent/evals/judge-check/dream/*.yaml`.
 *
 * Reply half (see "Chat replies" below). Each item is a Chat reply to a real
 * opener of a real person, and the checks the judge must fail on it. Files
 * live in `agent/evals/judge-check/replies/*.yaml`.
 *
 * An item passes only when the judge's verdicts match the labels. A planted
 * failure it lets through is a miss. A clean item it flags is a false alarm.
 * Either one fails the check, and the sweep stops. Each file holds `items`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadYaml } from "eve/evals/loaders";
import { z } from "zod";

import {
  type AppliedChecks,
  checksFor,
  GRADED_REPLY_RUBRIC_IDS,
  judgedCheckIds,
  REPLY_COUNTED_CHECK_IDS,
  REPLY_HARD_CHECK_IDS,
  type ReplyItem,
} from "./checks.ts";
import { type LoadedPerson, loadPerson } from "./dataset.ts";
import {
  type DreamGradeResult,
  entrySourceText,
  eventWrittenText,
  factWrittenText,
  gradeDreamSource,
  splitClaims,
} from "./dream-accuracy.ts";
import { createGradeCache } from "./dream-grade-cache.ts";
import { type DreamSource, formatSourceForJudge } from "./dream-judge-input.ts";
import type { Grader } from "./grader.ts";
import { formatJournalContext } from "./judge-context.ts";
import { type ItemRef, recordCheck, type ScoreHost } from "./record.ts";
import {
  gradeReply,
  loadEmptyJournalPerson,
  type ReplyGradeResult,
} from "./reply-grade.ts";
import type { ReplyGradeInput } from "./rubric.ts";
import {
  JOURNALS,
  type ReplyGrade,
  SchemaError,
  type ToolCall,
  type UnsupportedClaim,
} from "./schema.ts";

export const JUDGE_CHECK_ID = "judge-check";
/** The check the severe verdict belongs to. */
export const SEVERE_CHECK = "no-severe-unsupported";
/** The check the other verdict belongs to. */
export const OTHER_CHECK = "dream-supported";

const bundledDreamDir = fileURLToPath(
  new URL("../judge-check/dream", import.meta.url)
);
const yamlFilePattern = /\.ya?ml$/u;
const slugPattern = /^[a-z0-9][a-z0-9-]*$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

export function dreamJudgeCheckDir(): string {
  return bundledDreamDir;
}

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

const text = z
  .string({
    error: (issue) =>
      issue.input === undefined ? "Required." : "Must be text.",
  })
  .trim()
  .min(1, "Must not be empty.");

const isoDate = z.preprocess(
  (value) =>
    // YAML turns an unquoted 2026-07-12 into a Date at UTC midnight.
    value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString().slice(0, 10)
      : value,
  z.string().regex(isoDatePattern, "Use YYYY-MM-DD.")
);

const writtenSchema = z
  .strictObject({
    events: z
      .array(z.strictObject({ date: isoDate.optional(), event: text }))
      .default(() => []),
    facts: z
      .array(z.strictObject({ fact: text, subject: text }))
      .default(() => []),
    profile: z.array(text).default(() => []),
    summary: text.optional(),
  })
  .refine(
    (written) =>
      written.summary !== undefined ||
      written.profile.length > 0 ||
      written.facts.length > 0 ||
      written.events.length > 0,
    "Write at least a summary, a profile sentence, a fact, or an event."
  );

export const dreamCheckItemSchema = z.strictObject({
  /** The verdicts the judge must reach. */
  expect: z.strictObject({
    /** Another unsupported claim, not severe. */
    other: z.boolean(),
    /** A claim of death, suicide, self-harm, abuse, or violence the entry does not support. */
    severe: z.boolean(),
  }),
  id: text.regex(
    slugPattern,
    "Use lowercase letters, digits, and dashes, starting with a letter or digit."
  ),
  source: z.strictObject({
    body: text,
    date: isoDate,
    title: text,
  }),
  /** Facts about the author's life, as the fact sheet shows them to the judge. */
  truth: z.array(text).default(() => []),
  /** One line: what is planted, or what makes the entry tricky. */
  why: text,
  /** What Dream wrote from the entry. */
  written: writtenSchema,
});
export type DreamCheckItem = z.infer<typeof dreamCheckItemSchema>;

export const dreamCheckFileSchema = z.strictObject({
  items: z.array(dreamCheckItemSchema).min(1, "List at least one item."),
});

function pathText(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    out +=
      typeof key === "number"
        ? `[${key}]`
        : `${out.length === 0 ? "" : "."}${String(key)}`;
  }
  return out.length === 0 ? "(top level)" : out;
}

/** Parses one file's plain object. Throws a `SchemaError` with one line per problem. */
export function parseDreamCheckFile(
  input: unknown,
  label = "judge-check file"
): DreamCheckItem[] {
  const result = dreamCheckFileSchema.safeParse(input);
  if (!result.success) {
    throw new SchemaError(
      `Invalid ${label}`,
      result.error.issues.map(
        (issue) => `${pathText(issue.path)}: ${issue.message}`
      )
    );
  }
  return result.data.items;
}

/** True when the labels say the judge must flag something. */
export function isPlanted(item: DreamCheckItem): boolean {
  return item.expect.severe || item.expect.other;
}

/** Every item in a folder of YAML files, in file name order. An id used twice is an error. */
async function loadCheckItems<T extends { id: string }>(
  dir: string,
  parse: (input: unknown, label: string) => T[]
): Promise<T[]> {
  const names = (await readdir(dir))
    .filter((name) => yamlFilePattern.test(name))
    .sort();
  const docs = await Promise.all(
    names.map((name) => loadYaml(join(dir, name)))
  );
  const items: T[] = [];
  const seen = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    for (const item of parse(docs[index], name)) {
      const earlier = seen.get(item.id);
      if (earlier !== undefined) {
        throw new Error(`${name} repeats the id "${item.id}" from ${earlier}.`);
      }
      seen.set(item.id, name);
      items.push(item);
    }
  }
  return items;
}

/** Every Dream item in the folder, in file name order. An id used twice is an error. */
export function loadDreamCheckItems(
  dir = dreamJudgeCheckDir()
): Promise<DreamCheckItem[]> {
  return loadCheckItems(dir, parseDreamCheckFile);
}

// ---------------------------------------------------------------------------
// What the judge sees
// ---------------------------------------------------------------------------

/** The item as a Dream source, written the way the real eval writes one. */
export function dreamSourceOf(item: DreamCheckItem): DreamSource {
  const { written } = item;
  return {
    sourceId: item.id,
    sourceKind: "entry",
    sourceText: entrySourceText(item.source),
    written: [
      ...(written.summary === undefined
        ? []
        : [{ itemKind: "summary" as const, text: written.summary }]),
      ...written.profile.map((sentence) => ({
        itemKind: "profile" as const,
        text: sentence,
      })),
      ...written.facts.map((fact) => ({
        itemKind: "fact" as const,
        text: factWrittenText(fact.subject, fact.fact),
      })),
      ...written.events.map((event) => ({
        itemKind: "event" as const,
        text: eventWrittenText(event.date ?? "", event.event),
      })),
    ],
  };
}

/** A fact sheet with only what the item says is true. */
export function formatCheckContext(item: DreamCheckItem): string {
  const truth =
    item.truth.length === 0
      ? ["- (nothing listed)"]
      : item.truth.map((line) => `- ${line}`);
  return [
    "# Fact sheet",
    "",
    "What is true about the author's life:",
    ...truth,
    "",
  ].join("\n");
}

/** What the judge is shown for an item. For the tests. */
export function judgeCheckPrompt(item: DreamCheckItem): {
  context: string;
  item: string;
} {
  return {
    context: formatCheckContext(item),
    item: formatSourceForJudge(dreamSourceOf(item)),
  };
}

// ---------------------------------------------------------------------------
// Matching the verdict to the label
// ---------------------------------------------------------------------------

export interface DreamVerdict {
  other: boolean;
  severe: boolean;
}

/** `missed` is a planted failure the judge let through. `false-alarm` is a flag on a clean item. */
export interface CheckMiss {
  check: typeof OTHER_CHECK | typeof SEVERE_CHECK;
  detail: string;
  kind: "false-alarm" | "missed";
}

export function verdictOf(claims: readonly UnsupportedClaim[]): DreamVerdict {
  const { other, severe } = splitClaims(claims);
  return { other: other.length > 0, severe: severe.length > 0 };
}

function quoted(claims: readonly UnsupportedClaim[]): string {
  return claims.map((claim) => `"${claim.quote}"`).join(", ");
}

/**
 * Compares the judge's verdicts with the labels, one check at a time. Both a
 * miss and a false alarm are mismatches. A claim the judge calls severe does
 * not count as `other`, so calling a planted severe claim `other` is both a
 * miss of the severe check and a false alarm of the other one.
 */
export function compareVerdict(
  expect: DreamVerdict,
  claims: readonly UnsupportedClaim[]
): { found: DreamVerdict; match: boolean; misses: CheckMiss[] } {
  const found = verdictOf(claims);
  const { other, severe } = splitClaims(claims);
  const misses: CheckMiss[] = [];
  const compare = (
    check: CheckMiss["check"],
    wanted: boolean,
    got: boolean,
    flagged: readonly UnsupportedClaim[],
    what: string
  ): void => {
    if (wanted && !got) {
      misses.push({
        check,
        detail: `The judge found no ${what} claim, but the item has one.`,
        kind: "missed",
      });
    } else if (!wanted && got) {
      misses.push({
        check,
        detail: `The judge flagged a ${what} claim that the label says is not there: ${quoted(flagged)}.`,
        kind: "false-alarm",
      });
    }
  };
  compare(SEVERE_CHECK, expect.severe, found.severe, severe, "severe");
  compare(OTHER_CHECK, expect.other, found.other, other, "other");
  return { found, match: misses.length === 0, misses };
}

// ---------------------------------------------------------------------------
// Grading and recording
// ---------------------------------------------------------------------------

/** Grades one item with the configured judge. Nothing is cached: the judge is what is being tested. */
export function gradeCheckItem(
  grader: Grader,
  item: DreamCheckItem
): Promise<DreamGradeResult> {
  const prompt = judgeCheckPrompt(item);
  return gradeDreamSource({
    cache: createGradeCache({
      key: undefined,
      model: grader.modelId,
      rubric: grader.dreamRubric,
    }),
    context: prompt.context,
    grader,
    itemId: `judge-check/dream/${item.id}`,
    source: dreamSourceOf(item),
  });
}

/** `judge-check/dream/<id>` */
export function judgeCheckItemId(item: Pick<DreamCheckItem, "id">): string {
  return `judge-check/dream/${item.id}`;
}

/**
 * Records `hard:judge-check`: a pass when the verdicts match the labels. The
 * metadata carries what the runner needs to list the misses: `misses` has the
 * `check`, `kind`, `detail`, and `itemId` of each. A call the judge could not
 * make is recorded as not graded, and the runner should read that as "the
 * judge could not be checked".
 */
export function recordJudgeCheck(
  t: ScoreHost,
  ref: ItemRef,
  item: DreamCheckItem,
  result: DreamGradeResult
): void {
  const common = {
    expected: item.expect,
    judgeModel: result.model,
    planted: isPlanted(item),
    rubric: result.rubric,
    why: item.why,
  };
  if (!result.ok) {
    recordCheck(t, ref, {
      checkId: JUDGE_CHECK_ID,
      extra: { ...common, claims: [], misses: [] },
      notGraded: true,
      reason: result.reason,
      tier: "hard",
    });
    return;
  }
  const { found, match, misses } = compareVerdict(item.expect, result.claims);
  recordCheck(t, ref, {
    checkId: JUDGE_CHECK_ID,
    evidence: result.claims[0]?.quote,
    extra: {
      ...common,
      claims: result.claims,
      found,
      misses: misses.map((miss) => ({ ...miss, itemId: ref.itemId })),
    },
    pass: match,
    reason: match ? undefined : misses.map((miss) => miss.detail).join(" "),
    tier: "hard",
  });
}

// ---------------------------------------------------------------------------
// Chat replies
// ---------------------------------------------------------------------------
//
// An item is a reply to a real opener of a real person. The opener supplies
// the message and its labels (`expect`, `thought`, `fits`, `avoid`, `style`,
// `search`, `tags`), and the person's fact sheet and journal go to the judge as
// they do for a real reply. The item adds the reply, the tool calls, and the
// verdicts: the checks the judge must fail. Every other check that applies must
// pass. A rubric bound says how a clean reply must score, such as a
// listening-only reply that must get at least 4 for the right kind of help.

const bundledRepliesDir = fileURLToPath(
  new URL("../judge-check/replies", import.meta.url)
);

export function replyJudgeCheckDir(): string {
  return bundledRepliesDir;
}

/** The checks a label can say the judge must fail. */
export const REPLY_CHECK_IDS = [
  ...REPLY_HARD_CHECK_IDS,
  ...REPLY_COUNTED_CHECK_IDS,
] as const;

const rubricLevel = z.number().int().min(1).max(5);

const rubricBoundSchema = z
  .strictObject({
    max: rubricLevel.optional(),
    min: rubricLevel.optional(),
  })
  .refine(
    (bound) => bound.min !== undefined || bound.max !== undefined,
    "Give a min, a max, or both."
  )
  .refine(
    (bound) =>
      bound.min === undefined ||
      bound.max === undefined ||
      bound.min <= bound.max,
    "min must not exceed max."
  );

const checkToolCallSchema = z.strictObject({
  input: z.record(z.string(), z.json()).default(() => ({})),
  name: text,
  output: z.json().optional(),
  status: z
    .enum(["completed", "failed", "pending", "rejected"])
    .default("completed"),
});

export const replyCheckItemSchema = z.strictObject({
  /** The verdicts the judge must reach. */
  expect: z
    .strictObject({
      /** Checks the judge must fail. Every other check that applies must pass. */
      fails: z
        .array(z.enum(REPLY_CHECK_IDS))
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Remove repeated checks."
        )
        .default(() => []),
      /** How a rubric item must score, from 1 to 5. */
      rubric: z
        .partialRecord(z.enum(GRADED_REPLY_RUBRIC_IDS), rubricBoundSchema)
        .default(() => ({})),
    })
    .prefault({}),
  id: text.regex(
    slugPattern,
    "Use lowercase letters, digits, and dashes, starting with a letter or digit."
  ),
  /** Run on the person's own journal, or on the empty one. */
  journal: z.enum(JOURNALS).default("own"),
  /** An opener of that person. It gives the message and its labels. */
  opener: text.regex(slugPattern, "Use an opener id."),
  person: text.regex(slugPattern, "Use a person id."),
  /** What Sage said. */
  reply: text,
  /** Tags added to the opener's own. `injection` turns on that check. */
  tags: z.array(text).default(() => []),
  /** What Sage did before it replied. */
  toolCalls: z.array(checkToolCallSchema).default(() => []),
  /** One line: what is planted, or what the item shows is clean. */
  why: text,
});
export type ReplyCheckItem = z.infer<typeof replyCheckItemSchema>;

export const replyCheckFileSchema = z.strictObject({
  items: z.array(replyCheckItemSchema).min(1, "List at least one item."),
});

/** Parses one file's plain object. Throws a `SchemaError` with one line per problem. */
export function parseReplyCheckFile(
  input: unknown,
  label = "judge-check file"
): ReplyCheckItem[] {
  const result = replyCheckFileSchema.safeParse(input);
  if (!result.success) {
    throw new SchemaError(
      `Invalid ${label}`,
      result.error.issues.map(
        (issue) => `${pathText(issue.path)}: ${issue.message}`
      )
    );
  }
  return result.data.items;
}

/** True when the labels say the judge must fail a check. */
export function isReplyPlanted(item: ReplyCheckItem): boolean {
  return item.expect.fails.length > 0;
}

/** Every reply item in the folder, in file name order. An id used twice is an error. */
export function loadReplyCheckItems(
  dir = replyJudgeCheckDir()
): Promise<ReplyCheckItem[]> {
  return loadCheckItems(dir, parseReplyCheckFile);
}

/** `judge-check/reply/<id>` */
export function replyCheckItemId(item: Pick<ReplyCheckItem, "id">): string {
  return `judge-check/reply/${item.id}`;
}

export interface ResolvedReplyCheck {
  /** The fact sheet and journal the judge is shown. */
  context: string;
  item: ReplyCheckItem;
  /** The opener's message. */
  message: string;
  /** The opener's labels, with the item's extra tags. */
  replyItem: ReplyItem;
  toolCalls: ToolCall[];
}

export interface ReplyCheckDeps {
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
  /** The date the journal reads as today. Defaults to `SAGE_TODAY`. */
  today?: string;
}

/**
 * Joins an item with the person and the opener it is based on. Throws a
 * readable error when the person or the opener is gone, when a label names a
 * check that does not apply to the message (a crisis check on a venting
 * message, say), or when a rubric bound names an item that is N/A.
 */
export async function resolveReplyCheckItem(
  item: ReplyCheckItem,
  deps: ReplyCheckDeps = {}
): Promise<ResolvedReplyCheck> {
  const load = deps.loadPerson ?? loadPerson;
  const person = await load(item.person);
  const opener = person.personCase.openers.find(
    (candidate) => candidate.id === item.opener
  );
  if (opener === undefined) {
    throw new Error(
      `${item.id}: ${person.id} has no opener "${item.opener}". Known: ${person.personCase.openers.map((candidate) => candidate.id).join(", ")}.`
    );
  }
  const replyItem: ReplyItem = {
    avoid: opener.avoid,
    expect: opener.expect,
    fits: opener.fits,
    journalEmpty: item.journal === "empty" || person.empty,
    kind: "opener",
    search: opener.search,
    style: opener.style,
    tags: [...new Set([...opener.tags, ...item.tags])],
    thought: opener.thought,
  };
  const applied = checksFor(replyItem);
  const judged: string[] = judgedCheckIds(applied);
  for (const id of item.expect.fails) {
    if (!judged.includes(id)) {
      throw new Error(
        `${item.id}: ${id} does not apply to ${person.id}/${opener.id} (${opener.expect}). It applies to: ${judged.join(", ")}.`
      );
    }
  }
  for (const id of Object.keys(item.expect.rubric)) {
    const ask = applied.rubric.find((candidate) => candidate.id === id);
    if (ask === undefined || ask.notApplicable !== null) {
      throw new Error(
        `${item.id}: ${id} is N/A for ${person.id}/${opener.id}, so it cannot have a bound.`
      );
    }
  }
  const source =
    item.journal === "empty" ? await loadEmptyJournalPerson(load) : person;
  return {
    context: formatJournalContext(source, {
      today: deps.today ?? process.env.SAGE_TODAY,
    }),
    item,
    message: opener.message,
    replyItem,
    toolCalls: item.toolCalls.map((call) => ({
      input: call.input,
      name: call.name,
      ...(call.output === undefined ? {} : { output: call.output }),
      status: call.status,
    })),
  };
}

/** The input the judge's reply call is built from. */
export function replyCheckInput(resolved: ResolvedReplyCheck): ReplyGradeInput {
  return {
    context: resolved.context,
    item: resolved.replyItem,
    label: `judge-check ${replyCheckItemId(resolved.item)}`,
    message: resolved.message,
    reply: resolved.item.reply,
    toolCalls: resolved.toolCalls,
  };
}

/** Grades one item with the configured judge. Nothing is cached: the judge is what is being tested. */
export function gradeReplyCheckItem(
  grader: Grader,
  resolved: ResolvedReplyCheck
): Promise<ReplyGradeResult> {
  return gradeReply(grader, replyCheckInput(resolved));
}

export interface ReplyFound {
  /** The checks the judge failed. */
  failed: string[];
  /** The level the judge gave each rubric item that has a bound. Null is N/A or none. */
  levels: Record<string, number | null>;
}

/** `missed` is a planted failure the judge let through. `false-alarm` is a clean check or score it flagged. */
export interface ReplyCheckMiss {
  check: string;
  detail: string;
  kind: "false-alarm" | "missed";
}

/** The checks the judge failed. `journal-right` also fails when the judge lists a journal error. */
export function flaggedChecks(
  applied: AppliedChecks,
  grade: ReplyGrade
): string[] {
  return judgedCheckIds(applied).filter((id) => {
    const verdict = [...grade.hard, ...grade.counted].find(
      (entry) => entry.id === id
    );
    return (
      verdict?.pass === false ||
      (id === "journal-right" && grade.journalErrors.length > 0)
    );
  });
}

function whyFlagged(id: string, grade: ReplyGrade): string {
  const verdict = [...grade.hard, ...grade.counted].find(
    (entry) => entry.id === id
  );
  const [error] = grade.journalErrors;
  const quote = verdict?.evidence || error?.evidence;
  const reason = verdict?.reason || error?.reason;
  return [quote ? `"${quote}"` : "", reason ?? ""].filter(Boolean).join(": ");
}

/**
 * Compares the judge's verdicts with the labels, one check at a time. A check
 * the judge fails that the label does not list is a false alarm. A listed check
 * it passes is a miss. A rubric bound is broken when the level is under the
 * `min` (a false alarm: a clean reply scored low) or over the `max` (a miss).
 * A level the judge left out or called N/A breaks both kinds of bound.
 */
export function compareReplyVerdict(
  resolved: ResolvedReplyCheck,
  grade: ReplyGrade
): { found: ReplyFound; match: boolean; misses: ReplyCheckMiss[] } {
  const applied = checksFor(resolved.replyItem);
  const failed = flaggedChecks(applied, grade);
  const misses: ReplyCheckMiss[] = [];
  for (const id of judgedCheckIds(applied)) {
    const expected = resolved.item.expect.fails.includes(
      id as (typeof REPLY_CHECK_IDS)[number]
    );
    const got = failed.includes(id);
    if (expected && !got) {
      misses.push({
        check: id,
        detail: `The judge passed ${id}, but the reply was written to fail it.`,
        kind: "missed",
      });
    } else if (!expected && got) {
      misses.push({
        check: id,
        detail: `The judge failed ${id} (${whyFlagged(id, grade)}), but the label says it passes.`,
        kind: "false-alarm",
      });
    }
  }
  const levels: Record<string, number | null> = {};
  for (const [id, bound] of Object.entries(resolved.item.expect.rubric)) {
    const level = grade.rubric.find((entry) => entry.id === id)?.level ?? null;
    levels[id] = level;
    const shown = level === null ? "N/A" : String(level);
    if (bound.min !== undefined && (level === null || level < bound.min)) {
      misses.push({
        check: id,
        detail: `The judge scored ${id} ${shown}, but the label needs at least ${bound.min}.`,
        kind: "false-alarm",
      });
    }
    if (bound.max !== undefined && (level === null || level > bound.max)) {
      misses.push({
        check: id,
        detail: `The judge scored ${id} ${shown}, but the label allows at most ${bound.max}.`,
        kind: "missed",
      });
    }
  }
  return { found: { failed, levels }, match: misses.length === 0, misses };
}

/**
 * Records `hard:judge-check` for a reply item: a pass when the verdicts match
 * the labels. The metadata is the same as the Dream half's, so the runner
 * reads both the same way: `misses` has the `check`, `kind`, `detail`, and
 * `itemId` of each. A call the judge could not make is recorded as not graded.
 */
export function recordReplyJudgeCheck(
  t: ScoreHost,
  ref: ItemRef,
  resolved: ResolvedReplyCheck,
  result: ReplyGradeResult
): void {
  const common = {
    expected: resolved.item.expect,
    judgeModel: result.model,
    planted: isReplyPlanted(resolved.item),
    rubric: result.rubric,
    why: resolved.item.why,
  };
  if (!result.ok) {
    recordCheck(t, ref, {
      checkId: JUDGE_CHECK_ID,
      extra: { ...common, misses: [] },
      notGraded: true,
      reason: result.reason,
      tier: "hard",
    });
    return;
  }
  const { found, match, misses } = compareReplyVerdict(resolved, result.grade);
  recordCheck(t, ref, {
    checkId: JUDGE_CHECK_ID,
    evidence: result.grade.hard[0]?.evidence,
    extra: {
      ...common,
      found,
      judgeCallId: result.callId,
      judgeCostUsd: result.costUsd,
      misses: misses.map((miss) => ({ ...miss, itemId: ref.itemId })),
    },
    pass: match,
    reason: match ? undefined : misses.map((miss) => miss.detail).join(" "),
    tier: "hard",
  });
}
