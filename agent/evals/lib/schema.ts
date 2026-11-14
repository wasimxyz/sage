/**
 * Contracts for the eval suite.
 *
 * Every later piece (runner, loader, eval files, grader, viewer) builds on the
 * shapes in this file: the vocabularies, the sweep file, `case.yaml`, the
 * transcript rows that connect generation to grading, what the judge returns,
 * the reports, and the environment variables each pass reads.
 *
 * The file loads cheaply and never reads the environment at import time,
 * because eve imports every eval file before it filters them.
 *
 * YAML text is parsed elsewhere (`loadYaml` from `eve/evals/loaders` reads
 * files, and eve exposes no string parser), so the parsers here take plain
 * objects. The judge schemas use only enums, literals, strings, booleans,
 * numbers, arrays, and nullable fields, so the AI SDK can send them as JSON
 * schema.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A file or object that does not match its schema. One line per problem. */
export class SchemaError extends Error {
  readonly issues: string[];

  constructor(label: string, issues: string[]) {
    super(`${label}\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "SchemaError";
    this.issues = issues;
  }
}

function childOf(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<PropertyKey, unknown>)[key];
}

function itemIdOf(value: unknown): string | undefined {
  const id = childOf(value, "id");
  return typeof id === "string" ? id : undefined;
}

/** `openers[2].fits[1] (in rent-panic)`: the path, plus the nearest item id. */
function describePath(root: unknown, path: readonly PropertyKey[]): string {
  let current = root;
  let text = "";
  let nearestId: string | undefined;
  for (const key of path) {
    current = childOf(current, key);
    if (typeof key === "number") {
      text += `[${key}]`;
      nearestId = itemIdOf(current) ?? nearestId;
    } else {
      text += text.length === 0 ? String(key) : `.${String(key)}`;
    }
  }
  if (text.length === 0) {
    return "(top level)";
  }
  return nearestId === undefined ? text : `${text} (in ${nearestId})`;
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
      (issue) => `${describePath(input, issue.path)}: ${issue.message}`
    )
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const slugPattern = /^[a-z0-9][a-z0-9-]*$/u;
const nameSlugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const setupIdPattern = /^[0-9a-f]{10}$/u;
const wholeNumberPattern = /^\d+$/u;
const pathSeparatorPattern = /[/:]/gu;

const SETUP_ID_LENGTH = 10;

/** Non-empty text with its ends trimmed. */
const text = z
  .string({
    error: (issue) =>
      issue.input === undefined ? "Required." : "Must be text.",
  })
  .trim()
  .min(1, "Must not be empty.");

/** A lowercase id such as `rent-panic`. Used for people, openers, conversations. */
const slug = text.regex(
  slugPattern,
  "Use lowercase letters, digits, and dashes, starting with a letter or digit."
);

/** A prompt or Dream prompt name. It names a file or folder, so no path characters. */
const promptName = text.regex(
  nameSlugPattern,
  "Use letters, digits, dots, dashes, and underscores only."
);

const modelName = text;

/** A single string counts as a list of one. */
const textList = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(text)
);

function vocabulary<const T extends readonly [string, ...string[]]>(
  label: string,
  values: T
) {
  return z.enum(values, {
    error: (issue) => {
      const choices = `Use one of: ${values.join(", ")}.`;
      if (issue.input === undefined) {
        return `Missing ${label}. ${choices}`;
      }
      return `Unknown ${label} ${JSON.stringify(issue.input)}. ${choices}`;
    },
  });
}

function hasNoRepeats(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueList<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .min(1, "List at least one value.")
    .refine(hasNoRepeats, "Remove repeated values.");
}

function dateToIso(value: unknown): unknown {
  // YAML turns an unquoted 2026-07-12 into a Date at UTC midnight.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return value;
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** `YYYY-MM-DD`. A Date from the YAML parser is converted. */
const isoDate = z.preprocess(
  dateToIso,
  z
    .string({
      error: (issue) =>
        issue.input === undefined ? "Required." : "Use YYYY-MM-DD.",
    })
    .regex(isoDatePattern, "Use YYYY-MM-DD.")
    .refine(isRealDate, "Not a real calendar date.")
);

/** A 1-based entry number, or a file stem such as `2026-06-14-first-run`. */
const entryRef = z.union([z.number().int().min(1), text], {
  error: "Use a 1-based entry number or a file stem (no .md).",
});

export type EntryRef = z.infer<typeof entryRef>;

/** Marks a `needs` entry that names a past chat: `chat:2026-09-16-three-questions`. */
export const CHAT_NEED_PREFIX = "chat:";

/** The chat stem of a `chat:<stem>` ref, or null for any other ref. */
export function chatNeedStem(ref: number | string): string | null {
  if (typeof ref !== "string" || !ref.startsWith(CHAT_NEED_PREFIX)) {
    return null;
  }
  return ref.slice(CHAT_NEED_PREFIX.length);
}

/**
 * What a `needs` list holds: an entry (a 1-based number or a file stem), or a
 * past chat written as `chat:<stem>`, where the stem is the chat file's name
 * without `.md`.
 */
const needRef = z
  .union([z.number().int().min(1), text], {
    error:
      "Use an entry number, an entry file stem, or chat:<chat file stem> (no .md).",
  })
  .refine((ref) => {
    const stem = chatNeedStem(ref);
    return stem === null || (stem.length > 0 && !stem.includes(" "));
  }, "Write a past chat as chat:<stem>, such as chat:2026-09-16-three-questions.");

export type NeedRef = z.infer<typeof needRef>;

// ---------------------------------------------------------------------------
// 1. Vocabularies
// ---------------------------------------------------------------------------

export const KINDS_OF_HELP = [
  "listen",
  "look-at-thought",
  "step-back",
  "weigh-decision",
  "small-step",
  "grounding",
  "self-compassion",
  "problem-solving",
  "values",
] as const;
export type KindOfHelp = (typeof KINDS_OF_HELP)[number];

export const STYLES = [
  "terse",
  "therapy-savvy",
  "people-pleaser",
  "jokes",
  "skeptic",
  "rambler",
  "second-language",
  "swings",
] as const;
export type Style = (typeof STYLES)[number];

export const EXPECTS = [
  "venting",
  "crisis",
  "good-news",
  "question",
  "advice",
  "pushback",
  "goodbye",
  "anger",
  "privacy",
  "messy",
  "recap",
  "differs",
  "judge-other",
] as const;
export type Expect = (typeof EXPECTS)[number];

export const WANTS = [
  "vent",
  "understand",
  "decide",
  "change",
  "unsure",
] as const;
export type Wants = (typeof WANTS)[number];

export const OPENNESS = ["open", "guarded", "resistant"] as const;
export type Openness = (typeof OPENNESS)[number];

export const EXERCISE_OFFER_RESPONSES = [
  "accept",
  "decline",
  "unsure",
] as const;
export type ExerciseOfferResponse = (typeof EXERCISE_OFFER_RESPONSES)[number];

export const SEARCH_EXPECTATIONS = ["needed", "optional", "none"] as const;
export type SearchExpectation = (typeof SEARCH_EXPECTATIONS)[number];

export const JOURNAL_ERROR_KINDS = [
  "made-up",
  "wrong-person",
  "wrong-time",
  "out-of-date",
  "wrong-credit",
  "misquote",
  "wrong-detail",
] as const;
export type JournalErrorKind = (typeof JOURNAL_ERROR_KINDS)[number];

export const CLAIM_SEVERITIES = ["severe", "other"] as const;
export type ClaimSeverity = (typeof CLAIM_SEVERITIES)[number];

export const EVENT_WEIGHTS = ["big", "medium", "small"] as const;
export type EventWeight = (typeof EVENT_WEIGHTS)[number];

export const DREAM_ITEM_KINDS = [
  "summary",
  "fact",
  "event",
  "profile",
  "chat-summary",
  "chat-title",
] as const;
export type DreamItemKind = (typeof DREAM_ITEM_KINDS)[number];

const kindOfHelpSchema = vocabulary("kind of help", KINDS_OF_HELP);
const styleSchema = vocabulary("style", STYLES);
const expectSchema = vocabulary("expect value", EXPECTS);
const wantsSchema = vocabulary("wants value", WANTS);
const opennessSchema = vocabulary("openness value", OPENNESS);
const exerciseOfferSchema = vocabulary(
  "onExerciseOffer value",
  EXERCISE_OFFER_RESPONSES
);
const searchExpectationSchema = vocabulary("search value", SEARCH_EXPECTATIONS);
const journalErrorKindSchema = vocabulary(
  "journal error kind",
  JOURNAL_ERROR_KINDS
);
const claimSeveritySchema = vocabulary("claim severity", CLAIM_SEVERITIES);
const eventWeightSchema = vocabulary("weight", EVENT_WEIGHTS);
const dreamItemKindSchema = vocabulary("Dream item kind", DREAM_ITEM_KINDS);

// ---------------------------------------------------------------------------
// 2. Check ids and tiers
// ---------------------------------------------------------------------------

/** One failure fails the setup. */
export const HARD_CHECK_IDS = [
  "crisis-handled",
  "no-severe-unsupported",
  "fast-enough",
  "fits-in-memory",
] as const;
export type HardCheckId = (typeof HARD_CHECK_IDS)[number];

/** Failures add up. Fewer is better. */
export const COUNTED_CHECK_IDS = [
  "dream-supported",
  "journal-right",
  "no-overreach",
  "no-harmful-agreement",
  "no-brushing-off",
  "asks-before-exercise",
  "drops-after-no",
  "stops-feeding-loop",
  "ignores-injected",
  "no-runaway-search",
  "turn-works",
  "retrieval-top-hit",
  "summary-exists",
  "memory-returns",
  "event-source",
] as const;
export type CountedCheckId = (typeof COUNTED_CHECK_IDS)[number];

/** Rubric items scored once per reply. */
export const REPLY_RUBRIC_IDS = [
  "understanding",
  "warmth",
  "questions-help",
  "focus",
  "right-help",
  "journal-use",
  "fits-moment",
  "weighs-events",
  "search-quality",
] as const;
export type ReplyRubricId = (typeof REPLY_RUBRIC_IDS)[number];

/** Rubric items scored once per conversation. `user-rating` comes from the simulated user. */
export const CONVERSATION_RUBRIC_IDS = [
  "follows-lead",
  "collaboration",
  "keeps-track",
  "user-rating",
] as const;
export type ConversationRubricId = (typeof CONVERSATION_RUBRIC_IDS)[number];

/** Small slips, counted and labeled on every reply. */
export const SLIP_IDS = [
  "shows-internals",
  "many-questions",
  "not-chat-length",
  "formatting",
  "wrong-pronouns",
  "assumptions",
] as const;
export type SlipId = (typeof SLIP_IDS)[number];

/** Search metrics. Soft, and no judge. */
export const SEARCH_METRIC_IDS = [
  "needless-search",
  "missed-search",
  "found-needed",
] as const;
export type SearchMetricId = (typeof SEARCH_METRIC_IDS)[number];

export type RubricId = ReplyRubricId | ConversationRubricId;
export type CheckId =
  | HardCheckId
  | CountedCheckId
  | RubricId
  | SlipId
  | SearchMetricId;

export type CheckTier = "hard" | "counted" | "rubric" | "slip" | "search";

function tiersFor<const T extends readonly string[]>(
  ids: T,
  tier: CheckTier
): Record<T[number], CheckTier> {
  return Object.fromEntries(ids.map((id) => [id, tier])) as Record<
    T[number],
    CheckTier
  >;
}

/** Every check id and the tier it belongs to. */
export const CHECK_TIERS: Readonly<Record<CheckId, CheckTier>> = {
  ...tiersFor(HARD_CHECK_IDS, "hard"),
  ...tiersFor(COUNTED_CHECK_IDS, "counted"),
  ...tiersFor(REPLY_RUBRIC_IDS, "rubric"),
  ...tiersFor(CONVERSATION_RUBRIC_IDS, "rubric"),
  ...tiersFor(SLIP_IDS, "slip"),
  ...tiersFor(SEARCH_METRIC_IDS, "search"),
};

export const ALL_CHECK_IDS = Object.keys(CHECK_TIERS) as CheckId[];

/** Checks the judge grades on a reply. The rest come from code or from the Dream grade. */
export const JUDGE_HARD_CHECK_IDS = [
  "crisis-handled",
  "no-severe-unsupported",
] as const;
export const JUDGE_COUNTED_CHECK_IDS = [
  "journal-right",
  "no-overreach",
  "no-harmful-agreement",
  "no-brushing-off",
  "asks-before-exercise",
  "drops-after-no",
  "ignores-injected",
] as const;
export const JUDGE_SLIP_IDS = ["wrong-pronouns", "assumptions"] as const;
export const JUDGE_CONVERSATION_RUBRIC_IDS = [
  "follows-lead",
  "collaboration",
  "keeps-track",
] as const;

/** Rubric items are stored as 0 to 1. Level 1 is 0 and level 5 is 1. */
export function rubricLevelToScore(level: number): number {
  return (level - 1) / 4;
}

// ---------------------------------------------------------------------------
// 3. Sweep file
// ---------------------------------------------------------------------------

export const DEFAULT_SUMMARY_MODEL = "qwen3.5:9b";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_CHAT_MODEL = "qwen3.5:9b";
export const DEFAULT_JUDGE_MODEL = "moonshotai/kimi-k3.1-pro";
export const DEFAULT_SIMULATED_USER_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_SIMULATED_USER_PROVIDERS = [
  "morph",
  "deepinfra",
  "runinfra",
  "relace",
] as const;
export const BASELINE_PROMPT = "baseline";

export const THINKING_VALUES = ["off", "on", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING_VALUES)[number];

export const MEMORY_VALUES = ["off", "on"] as const;
export type Memory = (typeof MEMORY_VALUES)[number];

export const TEST_KINDS = [
  "person",
  "dream-accuracy",
  "facts",
  "openers",
  "conversations",
  "head-to-head",
  "calibration",
] as const;
export type TestKind = (typeof TEST_KINDS)[number];

const thinkingSchema = vocabulary("thinking value", THINKING_VALUES);
const memorySchema = vocabulary("memory value", MEMORY_VALUES);
const testKindSchema = vocabulary("test kind", TEST_KINDS);

export const judgeSettingsSchema = z.strictObject({
  model: modelName.default(DEFAULT_JUDGE_MODEL),
});
export type JudgeSettings = z.infer<typeof judgeSettingsSchema>;

export const simulatedUserSettingsSchema = z.strictObject({
  maxOutputPricePerM: z.number().positive().default(0.5),
  model: modelName.default(DEFAULT_SIMULATED_USER_MODEL),
  providers: uniqueList(text).default(() => [
    ...DEFAULT_SIMULATED_USER_PROVIDERS,
  ]),
});
export type SimulatedUserSettings = z.infer<typeof simulatedUserSettingsSchema>;

const replyWordsSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(1)])
  .refine(
    ([min, max]) => min <= max,
    "The first number must not exceed the second."
  );

// Today's single run: the default models, the shipped prompt, thinking off,
// memory off like a shipped build, and the checks `make eval` ran before.
const defaultMemory = (): Memory[] => ["off"];
const defaultThinking = (): Thinking[] => ["off"];
const defaultTests = (): TestKind[] => ["person", "facts"];
const defaultReplyWords = (): [number, number] => [20, 180];

export const sweepFileSchema = z.strictObject({
  chatModels: uniqueList(modelName).default(() => [DEFAULT_CHAT_MODEL]),
  contextLengths: uniqueList(z.number().int().positive()).default(() => [
    32_768,
  ]),
  dreamPrompts: uniqueList(promptName).default(() => [BASELINE_PROMPT]),
  embedModels: uniqueList(modelName).default(() => [DEFAULT_EMBED_MODEL]),
  judge: judgeSettingsSchema.prefault({}),
  maxSwapGrowthMB: z.number().min(0).default(512),
  maxToolCallsPerTurn: z.number().int().min(1).default(6),
  memory: uniqueList(memorySchema).default(defaultMemory),
  p90LimitSeconds: z.number().positive().nullable().default(null),
  prompts: uniqueList(promptName).default(() => [BASELINE_PROMPT]),
  repeats: z.number().int().min(1).default(1),
  replyWords: replyWordsSchema.default(defaultReplyWords),
  simulatedUser: simulatedUserSettingsSchema.prefault({}),
  speedLimitSeconds: z.number().positive().default(20),
  spendingCapUsd: z.number().min(0).default(50),
  summaryModels: uniqueList(modelName).default(() => [DEFAULT_SUMMARY_MODEL]),
  tags: z.array(text).default(() => []),
  tests: uniqueList(testKindSchema).default(defaultTests),
  thinking: uniqueList(thinkingSchema).default(defaultThinking),
});
export type SweepFile = z.infer<typeof sweepFileSchema>;
export type SweepFileInput = z.input<typeof sweepFileSchema>;

export function parseSweepFile(
  input: unknown,
  label = "sweep file"
): SweepFile {
  return parseWith(sweepFileSchema, input, `Invalid ${label}`);
}

/** One combination of models, prompts, and settings. */
export const setupSchema = z.strictObject({
  chatModel: modelName,
  contextLength: z.number().int().positive(),
  dreamPrompt: promptName,
  embedModel: modelName,
  memory: memorySchema,
  prompt: promptName,
  summaryModel: modelName,
  thinking: thinkingSchema,
});
export type Setup = z.infer<typeof setupSchema>;

type SweepAxes = Pick<
  SweepFile,
  | "chatModels"
  | "contextLengths"
  | "dreamPrompts"
  | "embedModels"
  | "memory"
  | "prompts"
  | "summaryModels"
  | "thinking"
>;

/**
 * Every combination, in the runner's loop order: memory, then summary model,
 * embed model, and Dream prompt, then Chat prompt, chat model, context length,
 * and thinking. The last axis changes fastest.
 */
export function expandSetups(sweep: SweepAxes): Setup[] {
  const axes: [keyof Setup, readonly unknown[]][] = [
    ["memory", sweep.memory],
    ["summaryModel", sweep.summaryModels],
    ["embedModel", sweep.embedModels],
    ["dreamPrompt", sweep.dreamPrompts],
    ["prompt", sweep.prompts],
    ["chatModel", sweep.chatModels],
    ["contextLength", sweep.contextLengths],
    ["thinking", sweep.thinking],
  ];
  let rows: Record<string, unknown>[] = [{}];
  for (const [key, values] of axes) {
    rows = rows.flatMap((row) =>
      values.map((value) => ({ ...row, [key]: value }))
    );
  }
  return rows.map((row) => setupSchema.parse(row));
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => compareText(a, b));
    return Object.fromEntries(
      entries.map(([key, child]) => [key, sortKeys(child)])
    );
  }
  return value;
}

/** JSON with object keys in sorted order, so equal data gives equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, SETUP_ID_LENGTH);
}

function pickSetup(setup: Setup): Setup {
  return {
    chatModel: setup.chatModel,
    contextLength: setup.contextLength,
    dreamPrompt: setup.dreamPrompt,
    embedModel: setup.embedModel,
    memory: setup.memory,
    prompt: setup.prompt,
    summaryModel: setup.summaryModel,
    thinking: setup.thinking,
  };
}

/** A stable 10-character id. It ignores key order. */
export function setupId(setup: Setup): string {
  return shortHash(canonicalJson(pickSetup(setup)));
}

function labelPart(value: string | number): string {
  return String(value).replace(pathSeparatorPattern, "_");
}

/** A readable name for logs and file names. `/` and `:` become `_`. */
export function setupLabel(setup: Setup): string {
  return [
    `chat-${labelPart(setup.chatModel)}`,
    `prompt-${labelPart(setup.prompt)}`,
    `think-${labelPart(setup.thinking)}`,
    `ctx-${setup.contextLength}`,
    `mem-${labelPart(setup.memory)}`,
    `sum-${labelPart(setup.summaryModel)}`,
    `embed-${labelPart(setup.embedModel)}`,
    `dream-${labelPart(setup.dreamPrompt)}`,
  ].join("__");
}

/** The part of a setup that decides which Dream snapshot it uses. */
export type DreamKey = Pick<
  Setup,
  "dreamPrompt" | "embedModel" | "memory" | "summaryModel"
>;

export function dreamKey(setup: Setup): DreamKey {
  return {
    dreamPrompt: setup.dreamPrompt,
    embedModel: setup.embedModel,
    memory: setup.memory,
    summaryModel: setup.summaryModel,
  };
}

/** A short id for a Dream key, for grouping setups that share a snapshot. */
export function dreamKeyId(setup: Setup): string {
  return shortHash(canonicalJson(dreamKey(setup)));
}

// ---------------------------------------------------------------------------
// 4. Person case (`agent/evals/data/people/<id>/case.yaml`)
// ---------------------------------------------------------------------------

const castMemberSchema = z.strictObject({
  alive: z.boolean().optional(),
  name: text,
  note: text.optional(),
  pronouns: text.optional(),
  relation: text,
});
export type CastMember = z.infer<typeof castMemberSchema>;

const timelineEventSchema = z.strictObject({
  date: isoDate,
  weight: eventWeightSchema,
  what: text,
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

const factRefSchema = z.strictObject({
  reference: text,
  stale: text.optional(),
  subject: text,
});
export type FactRef = z.infer<typeof factRefSchema>;

const eventRefSchema = z.strictObject({
  entry: entryRef,
  reference: text,
});
export type EventRef = z.infer<typeof eventRefSchema>;

const summaryRefSchema = z.strictObject({
  entry: entryRef,
  reference: text,
});
export type SummaryRef = z.infer<typeof summaryRefSchema>;

const retrievalRefSchema = z.strictObject({
  expectEntry: entryRef,
  query: text,
  /** A time in a person's words, such as "in March". Narrows the search. */
  when: text.optional(),
});
export type RetrievalRef = z.infer<typeof retrievalRefSchema>;

const chatRefSchema = z.strictObject({
  expectTool: z.boolean().default(false),
  /** The answer should come from a search that passed `when`. */
  expectWhen: z.boolean().default(false),
  needs: z.array(needRef).default(() => []),
  question: text,
  reference: text,
  search: searchExpectationSchema.optional(),
});
export type ChatRef = z.infer<typeof chatRefSchema>;

function addOverlapIssues(
  opener: { avoid: string[]; fits: string[] },
  ctx: z.RefinementCtx
): void {
  for (const [index, kind] of opener.avoid.entries()) {
    if (opener.fits.includes(kind)) {
      ctx.addIssue({
        code: "custom",
        message: `"${kind}" is in both fits and avoid.`,
        path: ["avoid", index],
      });
    }
  }
}

const openerSchema = z
  .strictObject({
    /** Also run this opener on the empty journal. */
    alsoEmpty: z.boolean().default(false),
    avoid: z.array(kindOfHelpSchema).default(() => []),
    expect: expectSchema,
    fits: z.array(kindOfHelpSchema).default(() => []),
    id: slug,
    message: text,
    needs: z.array(needRef).default(() => []),
    search: searchExpectationSchema.optional(),
    /** A way of talking for this message. */
    style: styleSchema.optional(),
    tags: z.array(text).default(() => []),
    /** The thinking trap, if any. Information for the judge, not a target. */
    thought: text.optional(),
  })
  .superRefine(addOverlapIssues);
export type Opener = z.infer<typeof openerSchema>;

const personaSchema = z.strictObject({
  /** How the person acts after the scripted crisis message. */
  afterCrisis: text.optional(),
  boundaries: textList.default(() => []),
  endWhen: text.optional(),
  keyThought: text.optional(),
  onExerciseOffer: exerciseOfferSchema.default("unsure"),
  openness: opennessSchema,
  reveals: textList.default(() => []),
  /** The person keeps coming back to the same worry. */
  ruminates: z.boolean().default(false),
  situation: text,
  style: styleSchema,
  wants: wantsSchema,
});
export type Persona = z.infer<typeof personaSchema>;

const crisisSchema = z.strictObject({
  /** Inserted word for word. */
  message: text,
  /** The person's turn, counting the opening as turn 1. */
  turn: z.number().int().min(2),
});
export type ScriptedCrisis = z.infer<typeof crisisSchema>;

const MAX_CONVERSATION_TURNS = 30;
const DEFAULT_CONVERSATION_TURNS = 8;

interface ConversationShape {
  crisis?: { turn: number };
  maxTurns: number;
  persona: { afterCrisis?: string };
  script?: Record<string, string>;
}

function addCrisisIssues(
  conversation: ConversationShape,
  ctx: z.RefinementCtx
): void {
  const { crisis, maxTurns, persona } = conversation;
  if (crisis === undefined) {
    return;
  }
  if (crisis.turn > maxTurns) {
    ctx.addIssue({
      code: "custom",
      message: `Turn ${crisis.turn} is after maxTurns (${maxTurns}).`,
      path: ["crisis", "turn"],
    });
  }
  if (persona.afterCrisis === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "A conversation with a crisis needs persona.afterCrisis.",
      path: ["persona", "afterCrisis"],
    });
  }
}

function addScriptIssues(
  conversation: ConversationShape,
  ctx: z.RefinementCtx
): void {
  for (const key of Object.keys(conversation.script ?? {})) {
    const turn = Number(key);
    const path = ["script", key];
    if (!wholeNumberPattern.test(key) || turn < 2) {
      ctx.addIssue({
        code: "custom",
        message: `"${key}" is not a turn number. Use 2 or more; the opening is turn 1.`,
        path,
      });
    } else if (turn > conversation.maxTurns) {
      ctx.addIssue({
        code: "custom",
        message: `Turn ${turn} is after maxTurns (${conversation.maxTurns}).`,
        path,
      });
    } else if (turn === conversation.crisis?.turn) {
      ctx.addIssue({
        code: "custom",
        message: `Turn ${turn} is already the crisis turn.`,
        path,
      });
    }
  }
}

function checkConversation(
  conversation: ConversationShape,
  ctx: z.RefinementCtx
): void {
  addCrisisIssues(conversation, ctx);
  addScriptIssues(conversation, ctx);
}

const conversationSchema = z
  .strictObject({
    crisis: crisisSchema.optional(),
    expect: expectSchema,
    id: slug,
    maxTurns: z
      .number()
      .int()
      .min(2)
      .max(MAX_CONVERSATION_TURNS)
      .default(DEFAULT_CONVERSATION_TURNS),
    opening: text,
    persona: personaSchema,
    /** Fixed person turns, such as pushback or anger. Turn number to message. */
    script: z.record(z.string(), text).optional(),
    tags: z.array(text).default(() => []),
  })
  .superRefine(checkConversation);
export type Conversation = z.infer<typeof conversationSchema>;

function addDuplicateIdIssues(
  items: readonly { id: string }[],
  key: string,
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate id "${item.id}".`,
        path: [key, index, "id"],
      });
    }
    seen.add(item.id);
  }
}

export const personCaseSchema = z
  .strictObject({
    /** For the judge and the simulated user. Sage never sees it. */
    about: text,
    cast: z.array(castMemberSchema).default(() => []),
    chat: z.array(chatRefSchema).default(() => []),
    conversations: z.array(conversationSchema).default(() => []),
    events: z.array(eventRefSchema).default(() => []),
    facts: z.array(factRefSchema).default(() => []),
    id: slug,
    openers: z.array(openerSchema).default(() => []),
    retrieval: z.array(retrievalRefSchema).default(() => []),
    summaries: z.array(summaryRefSchema).default(() => []),
    tags: z.array(text).default(() => []),
    timeline: z.array(timelineEventSchema).default(() => []),
  })
  .superRefine((person, ctx) => {
    addDuplicateIdIssues(person.openers, "openers", ctx);
    addDuplicateIdIssues(person.conversations, "conversations", ctx);
  });
export type PersonCase = z.infer<typeof personCaseSchema>;

/** Throws a `SchemaError` that names each bad field by its path. */
export function parsePersonCase(input: unknown, label?: string): PersonCase {
  const named =
    label ?? `person case ${JSON.stringify(childOf(input, "id") ?? "?")}`;
  return parseWith(personCaseSchema, input, `Invalid ${named}`);
}

// ---------------------------------------------------------------------------
// 5. Transcript row (generation to grading)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_KINDS = ["opener", "conversation", "chat"] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export const JOURNALS = ["own", "empty"] as const;
export type Journal = (typeof JOURNALS)[number];

export const ENDED_REASONS = [
  "done",
  "max-turns",
  "simulator-error",
  "error",
] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];

export const TOOL_CALL_STATUSES = [
  "pending",
  "completed",
  "failed",
  "rejected",
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** Ways the simulated user can slip after a crisis turn. */
export const SIMULATED_USER_FLAGS = [
  "soft-after-crisis",
  "refused",
  "broke-character",
  "dropped-crisis",
  "ended-near-crisis",
] as const;
export type SimulatedUserFlag = (typeof SIMULATED_USER_FLAGS)[number];

const transcriptKindSchema = vocabulary("transcript kind", TRANSCRIPT_KINDS);
const journalSchema = vocabulary("journal", JOURNALS);
const endedSchema = vocabulary("ended value", ENDED_REASONS);
const toolCallStatusSchema = vocabulary("tool call status", TOOL_CALL_STATUSES);
const simulatedUserFlagSchema = vocabulary(
  "simulated-user flag",
  SIMULATED_USER_FLAGS
);

/** `person/opener/<id>`, `person/conversation/<id>`, or `person/chat/<N>`. */
export function itemIdFor(
  person: string,
  kind: TranscriptKind,
  key: string | number
): string {
  return `${person}/${kind}/${key}`;
}

export function parseItemId(
  id: string
): { key: string; kind: TranscriptKind; person: string } | null {
  const parts = id.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [person, kind, key] = parts;
  const known = TRANSCRIPT_KINDS.find((candidate) => candidate === kind);
  if (person === "" || key === "" || known === undefined) {
    return null;
  }
  if (known === "chat" && !wholeNumberPattern.test(key)) {
    return null;
  }
  return { key, kind: known, person };
}

export const toolCallSchema = z.strictObject({
  input: z.record(z.string(), z.json()),
  name: text,
  /** Missing when the call never resolved. */
  output: z.json().optional(),
  status: toolCallStatusSchema,
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const turnTimingSchema = z.strictObject({
  /** From `message.received` to the first non-blank `message.appended`. Null if none appeared. */
  firstVisibleMs: z.number().min(0).nullable(),
  toolMs: z.number().min(0),
  totalMs: z.number().min(0),
});
export type TurnTiming = z.infer<typeof turnTimingSchema>;

export const turnSchema = z.strictObject({
  error: z.string().optional(),
  role: vocabulary("role", ["user", "assistant"]),
  /** The model ids Ollama reported for each step of the reply. */
  stepModelIds: z.array(z.string()).default(() => []),
  text: z.string(),
  /** Only on assistant turns. */
  timing: turnTimingSchema.optional(),
  toolCalls: z.array(toolCallSchema).default(() => []),
});
export type Turn = z.infer<typeof turnSchema>;

function checkItemId(
  row: { itemId: string; kind: string; person: string },
  ctx: z.RefinementCtx
): void {
  const parsed = parseItemId(row.itemId);
  if (parsed === null) {
    ctx.addIssue({
      code: "custom",
      message:
        "Use person/opener/<id>, person/conversation/<id>, or person/chat/<N>.",
      path: ["itemId"],
    });
  } else if (parsed.person !== row.person || parsed.kind !== row.kind) {
    ctx.addIssue({
      code: "custom",
      message: `The id does not match person "${row.person}" and kind "${row.kind}".`,
      path: ["itemId"],
    });
  }
}

/** One JSON line per item and repeat. */
export const transcriptRowSchema = z
  .strictObject({
    ended: endedSchema,
    itemId: text,
    journal: journalSchema,
    kind: transcriptKindSchema,
    person: slug,
    /** 1-based. */
    repeat: z.number().int().min(1),
    setupId: text.regex(setupIdPattern, "Use the 10-character setup id."),
    simulatedUserFlags: z.array(simulatedUserFlagSchema).default(() => []),
    turns: z.array(turnSchema),
  })
  .superRefine(checkItemId);
export type TranscriptRow = z.infer<typeof transcriptRowSchema>;

export function parseTranscriptRow(
  input: unknown,
  label = "transcript row"
): TranscriptRow {
  return parseWith(transcriptRowSchema, input, `Invalid ${label}`);
}

// ---------------------------------------------------------------------------
// 6. Judge input and output
// ---------------------------------------------------------------------------
//
// Field order is the order the judge writes in: the quote first, then the
// reason, then the verdict. The same order puts hard checks before counted
// checks and rubric items.

const RUBRIC_LEVELS = [1, 2, 3, 4, 5] as const;
const rubricLevelSchema = z.literal(RUBRIC_LEVELS);
export type RubricLevel = (typeof RUBRIC_LEVELS)[number];

/** A yes or no check. `pass: null` means it does not apply to this reply. */
function verdictSchema<const T extends readonly [string, ...string[]]>(
  label: string,
  ids: T
) {
  // biome-ignore assist/source/useSortedKeys: the judge writes evidence, then reason, then the verdict
  return z.strictObject({
    id: vocabulary(label, ids),
    evidence: z.string(),
    reason: z.string(),
    pass: z.boolean().nullable(),
  });
}

/** A 1 to 5 score. `level: null` means N/A. */
function rubricScoreSchema<const T extends readonly [string, ...string[]]>(
  ids: T
) {
  // biome-ignore assist/source/useSortedKeys: the judge writes evidence, then reason, then the score
  return z.strictObject({
    id: vocabulary("rubric item", ids),
    evidence: z.string(),
    reason: z.string(),
    level: rubricLevelSchema.nullable(),
  });
}

const hardVerdictSchema = verdictSchema("hard check", JUDGE_HARD_CHECK_IDS);
const countedVerdictSchema = verdictSchema(
  "counted check",
  JUDGE_COUNTED_CHECK_IDS
);
const slipVerdictSchema = verdictSchema("slip", JUDGE_SLIP_IDS);
const replyRubricScoreSchema = rubricScoreSchema(REPLY_RUBRIC_IDS);
const conversationRubricScoreSchema = rubricScoreSchema(
  JUDGE_CONVERSATION_RUBRIC_IDS
);

export type CheckVerdict = z.infer<typeof countedVerdictSchema>;
export type RubricScore = z.infer<typeof replyRubricScoreSchema>;

// biome-ignore assist/source/useSortedKeys: the judge writes the kind, the quote, the truth, then the reason
export const journalErrorSchema = z.strictObject({
  kind: journalErrorKindSchema,
  /** The words in the reply that are wrong. */
  evidence: z.string(),
  /** What the journal, the fact sheet, or the past chat says instead. */
  truth: z.string(),
  reason: z.string(),
});
export type JournalError = z.infer<typeof journalErrorSchema>;

/** What the judge returns for one Chat reply. */
// biome-ignore assist/source/useSortedKeys: hard checks come first, then counted checks, then rubric items
export const replyGradeSchema = z.strictObject({
  hard: z.array(hardVerdictSchema),
  counted: z.array(countedVerdictSchema),
  rubric: z.array(replyRubricScoreSchema),
  slips: z.array(slipVerdictSchema),
  journalErrors: z.array(journalErrorSchema),
  /** The kinds of help the reply used. An exercise counts only if it was offered and accepted. */
  helpSeen: z.array(kindOfHelpSchema),
});
export type ReplyGrade = z.infer<typeof replyGradeSchema>;

export const unsupportedClaimSchema = z.strictObject({
  itemKind: dreamItemKindSchema,
  /** The text of the Dream item that holds the claim. */
  itemText: z.string(),
  /** The words that the source does not support. */
  quote: z.string(),
  reason: z.string(),
  severity: claimSeveritySchema,
});
export type UnsupportedClaim = z.infer<typeof unsupportedClaimSchema>;

/** What the judge returns for one Dream source, with everything Dream wrote from it. */
export const dreamSourceGradeSchema = z.strictObject({
  unsupportedClaims: z.array(unsupportedClaimSchema),
});
export type DreamSourceGrade = z.infer<typeof dreamSourceGradeSchema>;

// biome-ignore assist/source/useSortedKeys: the judge writes the turn, the quote, the reason, then the marks
export const loopMarkSchema = z.strictObject({
  /** The 1-based exchange: the person's message and Sage's reply. */
  turn: z.number().int(),
  evidence: z.string(),
  reason: z.string(),
  /** True when the person's message returns to the same worry. */
  returnsToWorry: z.boolean(),
  /** Whether the reply fed the loop. Null when the person did not return to the worry. */
  feedsLoop: z.boolean().nullable(),
});
export type LoopMark = z.infer<typeof loopMarkSchema>;

// biome-ignore assist/source/useSortedKeys: the judge writes the turn, the quote, the reason, then the flag
export const simulatedUserFlagMarkSchema = z.strictObject({
  /** The 1-based exchange the flag applies to. */
  turn: z.number().int(),
  evidence: z.string(),
  reason: z.string(),
  flag: simulatedUserFlagSchema,
});
export type SimulatedUserFlagMark = z.infer<typeof simulatedUserFlagMarkSchema>;

/** What the judge returns for one conversation. */
// biome-ignore assist/source/useSortedKeys: the rubric comes first, then the loop marks and flags
export const conversationGradeSchema = z.strictObject({
  rubric: z.array(conversationRubricScoreSchema),
  loopMarks: z.array(loopMarkSchema),
  simulatedUserFlags: z.array(simulatedUserFlagMarkSchema),
});
export type ConversationGrade = z.infer<typeof conversationGradeSchema>;

export const HEAD_TO_HEAD_WINNERS = ["a", "b", "tie"] as const;
export type HeadToHeadWinner = (typeof HEAD_TO_HEAD_WINNERS)[number];

/** What the judge returns when it compares two replies to the same message. */
export const headToHeadSchema = z.strictObject({
  reason: z.string(),
  winner: vocabulary("winner", HEAD_TO_HEAD_WINNERS),
});
export type HeadToHead = z.infer<typeof headToHeadSchema>;

/** What the simulated user returns each turn. */
export const simulatedUserTurnSchema = z.strictObject({
  done: z.boolean(),
  message: z.string(),
});
export type SimulatedUserTurn = z.infer<typeof simulatedUserTurnSchema>;

/** What the simulated user returns at the end of a conversation. */
export const simulatedUserRatingSchema = z.strictObject({
  rating: rubricLevelSchema,
  reason: z.string(),
});
export type SimulatedUserRating = z.infer<typeof simulatedUserRatingSchema>;

export function parseReplyGrade(
  input: unknown,
  label = "reply grade"
): ReplyGrade {
  return parseWith(replyGradeSchema, input, `Invalid ${label}`);
}

export function parseDreamSourceGrade(
  input: unknown,
  label = "Dream source grade"
): DreamSourceGrade {
  return parseWith(dreamSourceGradeSchema, input, `Invalid ${label}`);
}

export function parseConversationGrade(
  input: unknown,
  label = "conversation grade"
): ConversationGrade {
  return parseWith(conversationGradeSchema, input, `Invalid ${label}`);
}

export function parseHeadToHead(
  input: unknown,
  label = "head-to-head result"
): HeadToHead {
  return parseWith(headToHeadSchema, input, `Invalid ${label}`);
}

// ---------------------------------------------------------------------------
// 7. Reports
// ---------------------------------------------------------------------------

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_SUFFIX = ".report.json";
export const SWEEP_SUMMARY_SUFFIX = ".sweep.json";

/** `<sweepId>__<setupId>.report.json` */
export function reportFileName(sweepId: string, id: string): string {
  return `${sweepId}__${id}${REPORT_SUFFIX}`;
}

/** `<sweepId>.sweep.json` */
export function sweepSummaryFileName(sweepId: string): string {
  return `${sweepId}${SWEEP_SUMMARY_SUFFIX}`;
}

/**
 * The person on the rows of the judge check. The check runs before any person
 * or setup, so its rows carry this name instead, and setup reports leave them
 * out.
 */
export const JUDGE_CHECK_PERSON = "judge-check";

export const REPORT_ITEM_KINDS = [
  "opener",
  "conversation",
  "chat",
  "fact",
  "event",
  "summary",
  "retrieval",
  "dream-source",
] as const;
export type ReportItemKind = (typeof REPORT_ITEM_KINDS)[number];

/** `skipped` is not applicable (memory off). `not-graded` is a judge error or the spending cap. */
export const CHECK_OUTCOMES = [
  "pass",
  "fail",
  "skipped",
  "not-graded",
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const ITEM_STATUSES = ["graded", "not-graded", "skipped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const NON_RUBRIC_CHECK_IDS = [
  ...HARD_CHECK_IDS,
  ...COUNTED_CHECK_IDS,
  ...SLIP_IDS,
  ...SEARCH_METRIC_IDS,
] as const;
const RUBRIC_IDS = [...REPLY_RUBRIC_IDS, ...CONVERSATION_RUBRIC_IDS] as const;

export const reportCheckSchema = z.strictObject({
  evidence: z.string().default(""),
  id: vocabulary("check", NON_RUBRIC_CHECK_IDS),
  outcome: vocabulary("check outcome", CHECK_OUTCOMES),
  reason: z.string().default(""),
});
export type ReportCheck = z.infer<typeof reportCheckSchema>;

export const reportRubricSchema = z.strictObject({
  evidence: z.string().default(""),
  id: vocabulary("rubric item", RUBRIC_IDS),
  /** 1 to 5. Null is N/A. */
  level: rubricLevelSchema.nullable(),
  reason: z.string().default(""),
  /** `level` on the 0 to 1 scale. Null when `level` is null. */
  score: z.number().min(0).max(1).nullable(),
});
export type ReportRubric = z.infer<typeof reportRubricSchema>;

export const reportTurnSchema = turnSchema.extend({
  checks: z.array(reportCheckSchema).default(() => []),
  helpSeen: z.array(kindOfHelpSchema).default(() => []),
  journalErrors: z.array(journalErrorSchema).default(() => []),
  rubric: z.array(reportRubricSchema).default(() => []),
});
export type ReportTurn = z.infer<typeof reportTurnSchema>;

export const dreamSourceSchema = z.strictObject({
  sourceId: text,
  sourceKind: vocabulary("source kind", ["entry", "chat"]),
  sourceText: z.string(),
  unsupportedClaims: z.array(unsupportedClaimSchema).default(() => []),
  /** Everything Dream wrote from this source. */
  written: z.array(
    z.strictObject({ itemKind: dreamItemKindSchema, text: z.string() })
  ),
});
export type DreamSourceReport = z.infer<typeof dreamSourceSchema>;

export const reportItemSchema = z.strictObject({
  /** Item-wide checks, such as the loop check or a fact check. */
  checks: z.array(reportCheckSchema).default(() => []),
  costUsd: z.number().min(0).default(0),
  dream: dreamSourceSchema.optional(),
  ended: endedSchema.optional(),
  itemId: text,
  journal: journalSchema,
  kind: vocabulary("report item kind", REPORT_ITEM_KINDS),
  loopMarks: z.array(loopMarkSchema).default(() => []),
  note: z.string().optional(),
  person: slug,
  repeat: z.number().int().min(1),
  /** Conversation-wide rubric items, including the simulated user's rating. */
  rubric: z.array(reportRubricSchema).default(() => []),
  simulatedUserFlags: z.array(simulatedUserFlagMarkSchema).default(() => []),
  status: vocabulary("item status", ITEM_STATUSES),
  turns: z.array(reportTurnSchema).default(() => []),
});
export type ReportItem = z.infer<typeof reportItemSchema>;

const hardFailureSchema = z.strictObject({
  count: z.number().int().min(1),
  detail: z.string().default(""),
  id: vocabulary("hard check", HARD_CHECK_IDS),
});

const countedByCheckSchema = z.strictObject({
  failures: z.number().int().min(0),
  graded: z.number().int().min(0),
  id: vocabulary("counted check", COUNTED_CHECK_IDS),
  /** `failures / graded`. Zero when nothing was graded. */
  rate: z.number().min(0),
});

/** Slips and search metrics. They are soft: counted and shown, never ranked on. */
export const SOFT_CHECK_IDS = [...SLIP_IDS, ...SEARCH_METRIC_IDS] as const;
export type SoftCheckId = (typeof SOFT_CHECK_IDS)[number];

const softByCheckSchema = z.strictObject({
  failures: z.number().int().min(0),
  graded: z.number().int().min(0),
  id: vocabulary("soft check", SOFT_CHECK_IDS),
  /** `failures / graded`. Zero when nothing was graded. */
  rate: z.number().min(0),
});

/** What Chat did with its tools, over the assistant turns of the setup. */
export const toolUseSummarySchema = z.strictObject({
  /** Entries and chats read in full. */
  reads: z.number().int().min(0),
  /** Searches. The memory tool counts only with memory on. */
  searches: z.number().int().min(0),
  /** Every tool call that counts for the setup. */
  toolCalls: z.number().int().min(0),
  /** Time spent in tools, over all turns, in milliseconds. */
  toolMs: z.number().min(0),
  /** Assistant turns that were counted. */
  turns: z.number().int().min(0),
});
export type ToolUseSummary = z.infer<typeof toolUseSummarySchema>;

export const setupSummarySchema = z.strictObject({
  costUsd: z.number().min(0),
  /** Each counted check as a count and a rate. */
  countedByCheck: z.array(countedByCheckSchema).default(() => []),
  countedFailures: z.number().int().min(0),
  /** All counted failures per graded item. It can pass 1. */
  countedRate: z.number().min(0),
  firstWordMedianMs: z.number().min(0).nullable(),
  firstWordP90Ms: z.number().min(0).nullable(),
  graded: z.number().int().min(0),
  hardFailures: z.array(hardFailureSchema),
  modelSizeMB: z.number().min(0).nullable().default(null),
  notGraded: z.number().int().min(0),
  /** Mean of the rubric scores, on the 0 to 1 scale. Null when nothing was scored. */
  rubricMean: z.number().min(0).max(1).nullable(),
  /** Spread of the rubric mean across repeats, on the same scale. Null with fewer than two repeats. */
  rubricSpread: z.number().min(0).nullable(),
  skipped: z.number().int().min(0),
  /** Each slip and search metric as a count and a rate, over the turns where it applied. */
  softByCheck: z.array(softByCheckSchema).default(() => []),
  swapBaselineMB: z.number().nullable().default(null),
  swapGrowthMB: z.number().nullable(),
  toolUse: toolUseSummarySchema.default(() => ({
    reads: 0,
    searches: 0,
    toolCalls: 0,
    toolMs: 0,
    turns: 0,
  })),
});
export type SetupSummary = z.infer<typeof setupSummarySchema>;

export const setupReportSchema = z.strictObject({
  gitCommit: text,
  items: z.array(reportItemSchema),
  judge: judgeSettingsSchema,
  people: z.array(slug),
  promptShas: z.strictObject({
    /** The Chat prompt file. */
    chat: text,
    /** The resolved Dream prompt text. Null for the built-in prompts. */
    dream: text.nullable(),
    /** The judge rubric version. */
    rubric: text.optional(),
  }),
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  setup: setupSchema,
  setupId: text.regex(setupIdPattern, "Use the 10-character setup id."),
  simulatedUser: simulatedUserSettingsSchema,
  summary: setupSummarySchema,
  sweepId: text,
});
export type SetupReport = z.infer<typeof setupReportSchema>;

export function parseSetupReport(
  input: unknown,
  label = "setup report"
): SetupReport {
  return parseWith(setupReportSchema, input, `Invalid ${label}`);
}

export const judgeCheckMissSchema = z.strictObject({
  /** The check that was planted, or the clean check that was flagged. */
  check: text,
  detail: z.string().default(""),
  itemId: text,
  /** `missed` is a planted failure the judge let through. `false-alarm` is a clean item it flagged. */
  kind: vocabulary("miss kind", ["missed", "false-alarm"]),
});
export type JudgeCheckMiss = z.infer<typeof judgeCheckMissSchema>;

export const rankingEntrySchema = z.strictObject({
  countedRate: z.number().min(0),
  firstWordMedianMs: z.number().min(0).nullable(),
  /** The hard checks that failed, when `passedHard` is false. */
  hardFailed: z
    .array(vocabulary("hard check", HARD_CHECK_IDS))
    .default(() => []),
  /** Some items were not graded, or none were. Incomplete setups rank last. */
  incomplete: z.boolean(),
  passedHard: z.boolean(),
  rubricMean: z.number().min(0).max(1).nullable(),
  setupId: text.regex(setupIdPattern, "Use the 10-character setup id."),
  spread: z.number().min(0).nullable(),
});
export type RankingEntry = z.infer<typeof rankingEntrySchema>;

export const sweepSummarySchema = z.strictObject({
  actual: z.strictObject({
    costUsd: z.number().min(0).nullable(),
    hours: z.number().min(0).nullable(),
  }),
  estimate: z.strictObject({
    costUsd: z.number().min(0),
    hours: z.number().min(0),
  }),
  judgeCheck: z.strictObject({
    misses: z.array(judgeCheckMissSchema),
    passed: z.boolean(),
  }),
  ranking: z.array(rankingEntrySchema),
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  /** The parsed sweep file, with defaults filled in. */
  sweep: sweepFileSchema,
  /** The file the sweep came from, such as `screen.yaml`. */
  sweepFile: text,
  sweepId: text,
});
export type SweepSummary = z.infer<typeof sweepSummarySchema>;

export function parseSweepSummary(
  input: unknown,
  label = "sweep summary"
): SweepSummary {
  return parseWith(sweepSummarySchema, input, `Invalid ${label}`);
}

/** The ranking row for one setup report. */
export function rankingEntryFor(report: SetupReport): RankingEntry {
  const { summary } = report;
  return {
    countedRate: summary.countedRate,
    firstWordMedianMs: summary.firstWordMedianMs,
    hardFailed: summary.hardFailures.map((failure) => failure.id),
    incomplete: summary.notGraded > 0 || summary.graded === 0,
    passedHard: summary.hardFailures.length === 0,
    rubricMean: summary.rubricMean,
    setupId: report.setupId,
    spread: summary.rubricSpread,
  };
}

export interface Rankable {
  countedRate: number;
  firstWordMedianMs: number | null;
  /** Some items were not graded, or none were. */
  incomplete: boolean;
  passedHard: boolean;
  rubricMean: number | null;
  setupId: string;
  spread: number | null;
}

/** Rubric means this close count as a tie. */
export const RUBRIC_TIE_MARGIN = 0.05;
const FLOAT_SLACK = 1e-9;

/** Groups neighbors in a sorted list. An item joins the group when it is close to the group's first item. */
function groupNeighbors<T>(
  sorted: readonly T[],
  joins: (first: T, item: T) => boolean
): T[][] {
  const groups: T[][] = [];
  let first: T | undefined;
  for (const item of sorted) {
    const current = groups.at(-1);
    if (current !== undefined && first !== undefined && joins(first, item)) {
      current.push(item);
    } else {
      groups.push([item]);
      first = item;
    }
  }
  return groups;
}

/** Larger first. A missing value goes last. */
function compareMeanDescending(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  return b === null ? -1 : b - a;
}

/** Smaller first. A missing value goes last. */
function compareAscending(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  return b === null ? -1 : a - b;
}

function meansTie(first: number | null, item: number | null): boolean {
  if (first === null || item === null) {
    return first === item;
  }
  return first - item <= RUBRIC_TIE_MARGIN + FLOAT_SLACK;
}

function compareSteadiness(a: Rankable, b: Rankable): number {
  return (
    compareAscending(a.spread ?? 0, b.spread ?? 0) ||
    compareAscending(a.firstWordMedianMs, b.firstWordMedianMs) ||
    compareText(a.setupId, b.setupId)
  );
}

function rankSameRate<T extends Rankable>(items: readonly T[]): T[] {
  const byMean = [...items].sort((a, b) =>
    compareMeanDescending(a.rubricMean, b.rubricMean)
  );
  const ties = groupNeighbors(byMean, (first, item) =>
    meansTie(first.rubricMean, item.rubricMean)
  );
  return ties.flatMap((tied) => [...tied].sort(compareSteadiness));
}

function rankGroup<T extends Rankable>(group: readonly T[]): T[] {
  const byRate = [...group].sort((a, b) => a.countedRate - b.countedRate);
  const sameRate = groupNeighbors(
    byRate,
    (first, item) => item.countedRate - first.countedRate <= FLOAT_SLACK
  );
  return sameRate.flatMap(rankSameRate);
}

/**
 * Setups with every item graded come before setups that are incomplete (some
 * items not graded, or none), because a rate over part of the items, or over
 * none, is not one to rank by. Within each of those two groups, setups that pass
 * every hard check come first. Within each group the lowest
 * counted-failure rate ranks first, then the highest rubric mean. Means within
 * 0.05 of the best in their group tie, and a tie goes to the lower spread, then
 * the lower median wait for the first word. A missing spread counts as 0. A
 * missing mean or wait ranks last.
 */
export function rankSetups<T extends Rankable>(summaries: readonly T[]): T[] {
  const ranked: T[] = [];
  for (const incomplete of [false, true]) {
    const part = summaries.filter(
      (summary) => summary.incomplete === incomplete
    );
    ranked.push(
      ...rankGroup(part.filter((summary) => summary.passedHard)),
      ...rankGroup(part.filter((summary) => !summary.passedHard))
    );
  }
  return ranked;
}

// ---------------------------------------------------------------------------
// 8. Environment contract
// ---------------------------------------------------------------------------

/** The variables each `eve eval` pass reads. */
export const EVAL_ENV = {
  data: "SAGE_EVAL_DATA",
  discoveryFile: "SAGE_DISCOVERY_FILE",
  dreamPrompts: "SAGE_EVAL_DREAM_PROMPTS",
  manifest: "SAGE_EVAL_MANIFEST",
  person: "SAGE_EVAL_PERSON",
  results: "SAGE_EVAL_RESULTS",
  runDir: "SAGE_EVAL_RUN_DIR",
  setupId: "SAGE_EVAL_SETUP_ID",
  sweepFile: "SAGE_EVAL_SWEEP_FILE",
  today: "SAGE_TODAY",
  transcripts: "SAGE_EVAL_TRANSCRIPTS",
} as const;

export const ENV_SWEEP_FILE = EVAL_ENV.sweepFile;
export const ENV_SETUP_ID = EVAL_ENV.setupId;
export const ENV_PERSON = EVAL_ENV.person;
export const ENV_RUN_DIR = EVAL_ENV.runDir;
export const ENV_TRANSCRIPTS = EVAL_ENV.transcripts;
export const ENV_RESULTS = EVAL_ENV.results;
export const ENV_MANIFEST = EVAL_ENV.manifest;
export const ENV_DATA = EVAL_ENV.data;
export const ENV_DREAM_PROMPTS = EVAL_ENV.dreamPrompts;
export const ENV_TODAY = EVAL_ENV.today;
export const ENV_DISCOVERY_FILE = EVAL_ENV.discoveryFile;

export type PassEnv = { [K in keyof typeof EVAL_ENV]: string | undefined };

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Reads the pass variables. A missing or empty value is `undefined`. It never throws. */
export function readPassEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): PassEnv {
  return {
    data: envValue(env, EVAL_ENV.data),
    discoveryFile: envValue(env, EVAL_ENV.discoveryFile),
    dreamPrompts: envValue(env, EVAL_ENV.dreamPrompts),
    manifest: envValue(env, EVAL_ENV.manifest),
    person: envValue(env, EVAL_ENV.person),
    results: envValue(env, EVAL_ENV.results),
    runDir: envValue(env, EVAL_ENV.runDir),
    setupId: envValue(env, EVAL_ENV.setupId),
    sweepFile: envValue(env, EVAL_ENV.sweepFile),
    today: envValue(env, EVAL_ENV.today),
    transcripts: envValue(env, EVAL_ENV.transcripts),
  };
}
