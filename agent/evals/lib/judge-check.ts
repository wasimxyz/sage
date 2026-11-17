/**
 * The judge check, Dream half.
 *
 * A small labeled set that proves the judge catches what it should before a
 * sweep spends hours on local generation. Each item is a journal entry, what
 * Dream wrote from it, and the verdicts we expect: is there a severe
 * unsupported claim, and is there any other unsupported claim. Some items are
 * written to fail one check. The rest are clean entries that a good summary
 * handles.
 *
 * An item passes only when the judge's verdicts match the labels. A planted
 * failure it lets through is a miss. A clean item it flags is a false alarm.
 * Either one fails the check, and the sweep stops.
 *
 * Files live in `agent/evals/judge-check/dream/*.yaml`. Each holds `items`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadYaml } from "eve/evals/loaders";
import { z } from "zod";

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
import { type ItemRef, recordCheck, type ScoreHost } from "./record.ts";
import { SchemaError, type UnsupportedClaim } from "./schema.ts";

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

/** Every item in the folder, in file name order. An id used twice is an error. */
export async function loadDreamCheckItems(
  dir = dreamJudgeCheckDir()
): Promise<DreamCheckItem[]> {
  const names = (await readdir(dir))
    .filter((name) => yamlFilePattern.test(name))
    .sort();
  const docs = await Promise.all(
    names.map((name) => loadYaml(join(dir, name)))
  );
  const items: DreamCheckItem[] = [];
  const seen = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    for (const item of parseDreamCheckFile(docs[index], name)) {
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
      rubric: grader.rubric,
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
