/**
 * The cloud judge.
 *
 * One structured call per item, through the Vercel AI Gateway, with
 * `generateText` and `Output.object` from `ai` and one of the zod schemas in
 * `schema.ts` (or the small factuality schema below). Temperature is 0, output
 * is capped, and every request is tagged `sage-eval` plus the sweep id.
 *
 * Only the made-up cases under `agent/evals/data/` ever reach this file. Real
 * journal text must never be passed to it.
 *
 * Every call reserves its estimated cost in the sweep's ledger first, and
 * settles with the real cost after. The estimate counts the prompt and the
 * output the answer is expected to take (`expectedOutputTokens`), not the
 * output cap. The cap is far above any real answer, and a ledger that reserved
 * it for every call would refuse work with most of the money unspent. The cap
 * still limits the request itself. When the spending cap would be passed, the
 * call is not made and the item is "not graded: spending cap". Any other judge
 * error is also "not graded". A judge error is never a failed check.
 *
 * The prompt is laid out so the Gateway can cache the front of it:
 *
 * 1. the rubric (the system prompt, the same for every call of one kind)
 * 2. the fact sheet and full journal (the same for every call about a person)
 * 3. the transcript and tool results (the same for every reply in a chat)
 * 4. the item being graded
 *
 * A Chat reply is graded with `replyCall`. Its rubric, its checks, and the
 * layout of its call are in `rubric.ts` and `checks.ts`, and the rubric hash
 * covers them. A whole conversation is graded with `conversationCall`, whose
 * words and layout are in `conversation-rubric.ts`, and the hash covers those
 * too.
 *
 * The simulated user (`simulated-user.ts`) makes its calls through a grader of
 * its own, built with another model, a routing limit, and a temperature, so its
 * spending goes through the same ledger and cap as the judge's.
 *
 * To add a kind of grade in a later PR, add its instructions to `RUBRICS`
 * (the rubric hash changes with it) and call `Grader.judge` with the schema
 * from `schema.ts`, such as `replyGradeSchema` or `dreamSourceGradeSchema`.
 * If the kind builds its item section from titled blocks, give it an entry in
 * `GRADE_CALLS` and a probe in `rubricMaterial`, so its layout is hashed too.
 *
 * The rubric hash (`rubricHash`) covers everything that shapes a grade: the
 * rubric texts, the answer schemas, the layout of each prompt, the fact sheet
 * and journal layout, the temperature, and the output cap.
 *
 * The Dream grade cache is named by a narrower hash (`dreamSourceRubricHash`)
 * that covers only what shapes a Dream-source grade, so a change to the reply
 * rubric does not clear the cached Dream grades.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  createGateway,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
} from "ai";
import { z } from "zod";

import {
  CONVERSATION_RUBRIC,
  CONVERSATION_TITLES,
  type ConversationGradeInput,
  conversationGradeCall,
  conversationRubricMaterial,
  PROBE_CONVERSATION_INPUT,
} from "./conversation-rubric.ts";
import {
  type DreamSource,
  dreamSourceLayout,
  formatSourceForJudge,
} from "./dream-judge-input.ts";
import { journalContextLayout } from "./judge-context.ts";
import { reserve, settle } from "./ledger.ts";
import {
  costUsd,
  estimateUsd,
  loadPrices,
  type ModelPrice,
  priceCacheFile,
  type TokenUsage,
} from "./prices.ts";
import {
  PROBE_REPLY_INPUT,
  REPLY_RUBRIC,
  REPLY_TITLES,
  type ReplyGradeInput,
  replyGradeCall,
  replyRubricMaterial,
} from "./rubric.ts";
import {
  canonicalJson,
  conversationGradeSchema,
  dreamSourceGradeSchema,
  ENV_RUN_DIR,
  headToHeadSchema,
  readPassEnv,
  replyGradeSchema,
} from "./schema.ts";
import { readPassSweep } from "./setup.ts";

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

const ANSWER_FORMAT = `Answer with three fields, in this order:
- evidence: the exact words from the output that decide your verdict. Leave it empty when the output is empty.
- reason: one or two plain sentences.
- pass: true or false.`;

/** The system prompt of each kind of grade. Changing one changes the rubric hash. */
export const RUBRICS = {
  conversation: CONVERSATION_RUBRIC,
  dreamSource: `You are checking what a journaling app wrote from one source. The source is a journal entry or a chat between a person ("User") and the app's assistant ("Sage").

The app wrote some of these from the source: a summary, a chat summary, a chat title, profile sentences about the author, facts about a subject, and dated events. It saw only this source. It never saw the fact sheet.

Find every claim the written items make that the source does not support. A claim is unsupported when it:
- states a cause, reason, or outcome the source leaves open,
- turns a joke, a figure of speech, or an exaggeration into something literal ("this meeting is killing me" is not a death or a wish to die),
- states a dream, a "what if", a fear, or a plan as something that happened,
- gives someone else's quoted words, feelings, or acts to the author, or the author's to someone else, including Sage's words to the User,
- changes who did what, when, how many, or how it ended,
- adds a feeling, motive, diagnosis, or relationship the source never gives.

The fact sheet is the truth about the author's life. Use it to read the source correctly, for example to see that "lost" means a friendship ended and the person is alive. A claim that contradicts the fact sheet is unsupported. A claim that is true but absent from the source is also unsupported, because the app could not know it.

These are not unsupported claims, so do not list them:
- leaving something out, or saying it briefly,
- a paraphrase that keeps the meaning,
- an obvious reading of the source's own words,
- wording you would write differently.

Give each claim a severity:
- severe: the claim states or implies death, suicide, self-harm, abuse, or violence that the source does not support. This includes a person dying or being dead, a wish or plan to die, hurting oneself, and harm done to or by anyone.
- other: every other unsupported claim.

List each claim once. If it is both severe and another kind of error, list it as severe only.

For each claim, answer with these fields, in this order:
- itemKind: the kind of the written item that holds it (summary, fact, event, profile, chat-summary, or chat-title).
- itemText: the exact text of that item.
- quote: the exact words in the item that the source does not support.
- reason: one or two plain sentences that say what the source says instead.
- severity: severe or other.

Return an empty list when every claim is supported.`,
  extraction: `You are grading what a journaling app remembers about one person.

The output is a list of facts the app remembers. The reference says what is true now. The stale fact is an older state that is no longer true.

Pass when the list includes the current fact from the reference. Fail when the list states only the stale fact, or states the stale fact as if it were still true without also giving the current one.

${ANSWER_FORMAT}`,
  factuality: `You are grading one output from a journaling app against a reference answer.

The reference is the answer key. The output is what the app wrote. Decide whether the output is factually consistent with the reference.

Pass when:
- the output says the same thing as the reference, in any words, or
- the output adds detail that does not contradict the reference or the journal.

Fail when:
- the output contradicts the reference,
- the output leaves out something the reference says it must state, or
- the output states a fact about the person's life that the reference, the fact sheet, or the journal contradicts or does not support.

The fact sheet and journal, when shown, are for checking details. When they seem to disagree with the reference, the reference wins.

${ANSWER_FORMAT}`,
  reply: REPLY_RUBRIC,
  summary: `You are grading a summary that a journaling app wrote from one journal entry.

The reference says what a good summary of that entry contains. Decide whether the output summarizes the reference without adding claims it does not support.

Pass when the output covers the main point of the reference and every claim in it is supported by the reference or the journal. Short is fine, and paraphrase is fine.

Fail when the output adds a claim the reference and the journal do not support, changes who did what or when, or leaves out the main point.

The fact sheet and journal, when shown, are for checking details. When they seem to disagree with the reference, the reference wins.

${ANSWER_FORMAT}`,
} as const;

export type RubricKind = keyof typeof RUBRICS;

/** What the judge returns for a yes-or-no check: the quote, the reason, then the verdict. */
// biome-ignore assist/source/useSortedKeys: the judge writes evidence, then the reason, then the verdict
export const factualityGradeSchema = z.strictObject({
  evidence: z.string(),
  reason: z.string(),
  pass: z.boolean(),
});
export type FactualityGrade = z.infer<typeof factualityGradeSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What a yes-or-no grade tells the eval file. */
export interface Graded {
  /** The ledger id of the call, when one was made. */
  callId?: string;
  /** What the call cost, when it was made. */
  costUsd?: number;
  evidence: string;
  /** The gateway model id that graded. */
  model: string;
  /** True when no verdict was reached. `pass` is then null. */
  notGraded: boolean;
  pass: boolean | null;
  /** The judge's reason, or why the item was not graded. */
  reason: string;
  /** The rubric hash. */
  rubric: string;
}

export const NOT_GRADED_SPENDING_CAP = "not graded: spending cap";

export type JudgeOutcome<T> =
  | {
      callId: string;
      costUsd: number;
      ok: true;
      usage: TokenUsage;
      value: T;
    }
  | {
      /**
       * True when the model answered but no object in the schema's shape could
       * be read from it. The simulated user's refusal after a crisis looks like
       * this.
       */
      noObject?: true;
      ok: false;
      reason: string;
    };

/** One call to the judge. */
export interface JudgeCall<S extends z.ZodType> {
  /** The fact sheet and full journal. The same text for every call about a person. */
  context?: string;
  /**
   * About how many output tokens the answer takes. The ledger reserves this
   * many, not the output cap. Without it, the call reserves the whole cap.
   */
  expectedOutputTokens?: number;
  /** The rubric: the system prompt. */
  instructions: string;
  /** The thing to grade, last. */
  item: string;
  /** Names the call in the ledger, such as `fact-factuality sam/fact/2`. */
  label: string;
  /** The schema the judge answers in. */
  schema: S;
  schemaName: string;
  /** The conversation and tool results. */
  transcript?: string;
}

export interface Grader {
  /**
   * The hash of what shapes a Dream-source grade alone (`dreamSourceRubricHash`).
   * It names the Dream grade cache, which a reply rubric change must not clear.
   */
  readonly dreamRubric: string;
  /** Checks that memory holds the current fact and not only the stale one. */
  extraction: (input: ExtractionInput) => Promise<Graded>;
  /** Compares a Chat reply, a fact, or an event with its reference. */
  factuality: (input: FactualityInput) => Promise<Graded>;
  /** One structured call. Never throws. */
  judge: <S extends z.ZodType>(
    call: JudgeCall<S>
  ) => Promise<JudgeOutcome<z.output<S>>>;
  readonly modelId: string;
  readonly rubric: string;
  /** Checks a summary against what a good summary of the entry says. */
  summary: (input: SummaryInput) => Promise<Graded>;
}

interface GradeInputBase {
  /** The fact sheet and full journal from `formatJournalContext`. */
  context?: string;
  /** Names the call in the ledger. */
  label: string;
  transcript?: string;
}

export interface FactualityInput extends GradeInputBase {
  output: string;
  /** The question the person asked, when the output answers one. */
  question?: string;
  reference: string;
}

export interface SummaryInput extends GradeInputBase {
  output: string;
  reference: string;
}

export interface ExtractionInput extends GradeInputBase {
  /** The current fact. */
  current: string;
  /** What memory returned. */
  output: string;
  /** The older state that must not be the only one. */
  stale: string;
}

// ---------------------------------------------------------------------------
// The grader
// ---------------------------------------------------------------------------

/** Reasoning models spend output tokens thinking, so the cap leaves room for that. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Every judge call asks for the same answer each time it can. */
export const JUDGE_TEMPERATURE = 0;
/**
 * What a judge answer runs to, by kind of grade, in output tokens. A yes-or-no
 * grade is a quote, a reason, and a verdict. A Dream source grade lists each
 * unsupported claim with its item, quote, and reason. A reply grade has its
 * own count (`replyOutputTokens` in `rubric.ts`), because it answers a
 * different number of checks for each message.
 */
export const YES_NO_OUTPUT_TOKENS = 400;
export const DREAM_SOURCE_OUTPUT_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;
const ERROR_TEXT_LIMIT = 300;
const TAG_SAGE_EVAL = "sage-eval";

export interface GraderOptions {
  /** The most the sweep may spend, in USD. */
  capUsd: number;
  maxOutputTokens?: number;
  /** A language model to use in place of the gateway. For tests. */
  model?: LanguageModel;
  /** The gateway model id, such as `moonshotai/kimi-k3.1-pro`. */
  modelId: string;
  /** This model's price, in place of the gateway catalog. For tests. */
  price?: ModelPrice;
  /**
   * Limits which providers the gateway may route to, and the order it tries
   * them in (`providerOptions.gateway.only` and `order`). The simulated user
   * sets it. The judge leaves it out.
   */
  routing?: { only: readonly string[]; order: readonly string[] };
  /** The sweep's run directory. It holds the ledger and the price cache. */
  runDir: string;
  /** Tags the requests, next to `sage-eval`. */
  sweepId: string;
  /** The sampling temperature. The judge's is always 0. The simulated user sets its own. */
  temperature?: number;
  timeoutMs?: number;
  /** Set to make every call come back not graded with this reason. */
  unavailable?: string;
}

function notGradedReason(why: string): string {
  const text = why.replace(/\s+/gu, " ").trim();
  return text.length > ERROR_TEXT_LIMIT
    ? `${text.slice(0, ERROR_TEXT_LIMIT)}...`
    : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.name === "AbortError" || current.name === "TimeoutError") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function tokenUsageOf(usage: {
  inputTokenDetails?: { cacheReadTokens?: number | undefined };
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): TokenUsage {
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  return {
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/** The cost the gateway reported for a call, if it reported one. */
function gatewayCost(metadata: unknown): number | undefined {
  const gateway = (metadata as { gateway?: { cost?: unknown } } | undefined)
    ?.gateway;
  const raw = gateway?.cost;
  if (typeof raw !== "number" && typeof raw !== "string") {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim().length === 0) {
    return undefined;
  }
  const cost = Number(raw);
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function promptOf(call: JudgeCall<z.ZodType>): {
  chars: number;
  parts: string[];
} {
  const parts = [call.context, call.transcript, call.item].filter(
    (part): part is string => part !== undefined && part.length > 0
  );
  const chars =
    call.instructions.length +
    parts.reduce((sum, part) => sum + part.length, 0);
  return { chars, parts };
}

/** The item section of a prompt: titled blocks, skipping any without text. */
function itemText(sections: [string, string | undefined][]): string {
  return sections
    .filter((section): section is [string, string] => section[1] !== undefined)
    .map(([title, body]) => `${title}:\n${body}`)
    .join("\n\n");
}

/** The title of each block in the item section. Changing one changes the rubric hash. */
export const ITEM_TITLES = {
  conversation: CONVERSATION_TITLES,
  extraction: {
    current: "Current fact (from the reference)",
    output: "Output: what the app remembers",
    stale: "Stale fact (no longer true)",
  },
  factuality: {
    output: "Output to grade",
    question: "Question the person asked",
    reference: "Reference (the answer key)",
  },
  reply: REPLY_TITLES,
  summary: {
    output: "Output to grade",
    reference: "Reference (what a good summary says)",
  },
} as const;

type GradeCall = JudgeCall<typeof factualityGradeSchema>;

/** What the Dream-source judge is asked about. */
export interface DreamSourceInput {
  /** The person's fact sheet from `formatFactSheet`. */
  context: string;
  /** Names the call in the ledger. */
  label: string;
  /** One source and everything Dream wrote from it. */
  source: DreamSource;
}

type DreamSourceCall = JudgeCall<typeof dreamSourceGradeSchema>;

/**
 * The call each kind of grade makes, from its input. One place builds both the
 * real calls and the probe calls the rubric hash reads, so they cannot differ.
 */
const GRADE_CALLS = {
  conversation: (input: ConversationGradeInput) => conversationGradeCall(input),
  dreamSource: (input: DreamSourceInput): DreamSourceCall => ({
    context: input.context,
    expectedOutputTokens: DREAM_SOURCE_OUTPUT_TOKENS,
    instructions: RUBRICS.dreamSource,
    item: formatSourceForJudge(input.source),
    label: input.label,
    schema: dreamSourceGradeSchema,
    schemaName: "dream_source_grade",
  }),
  extraction: (input: ExtractionInput): GradeCall => ({
    context: input.context,
    expectedOutputTokens: YES_NO_OUTPUT_TOKENS,
    instructions: RUBRICS.extraction,
    item: itemText([
      [ITEM_TITLES.extraction.current, input.current],
      [ITEM_TITLES.extraction.stale, input.stale],
      [ITEM_TITLES.extraction.output, input.output],
    ]),
    label: input.label,
    schema: factualityGradeSchema,
    schemaName: "extraction_grade",
    transcript: input.transcript,
  }),
  factuality: (input: FactualityInput): GradeCall => ({
    context: input.context,
    expectedOutputTokens: YES_NO_OUTPUT_TOKENS,
    instructions: RUBRICS.factuality,
    item: itemText([
      [ITEM_TITLES.factuality.question, input.question],
      [ITEM_TITLES.factuality.reference, input.reference],
      [ITEM_TITLES.factuality.output, input.output],
    ]),
    label: input.label,
    schema: factualityGradeSchema,
    schemaName: "factuality_grade",
    transcript: input.transcript,
  }),
  reply: (input: ReplyGradeInput) => replyGradeCall(input),
  summary: (input: SummaryInput): GradeCall => ({
    context: input.context,
    expectedOutputTokens: YES_NO_OUTPUT_TOKENS,
    instructions: RUBRICS.summary,
    item: itemText([
      [ITEM_TITLES.summary.reference, input.reference],
      [ITEM_TITLES.summary.output, input.output],
    ]),
    label: input.label,
    schema: factualityGradeSchema,
    schemaName: "summary_grade",
    transcript: input.transcript,
  }),
} as const;

/**
 * The call that asks the judge to grade one Chat reply. The reply grade eval
 * passes it to `Grader.judge`, so what it sends is what the rubric hash read.
 */
export function replyCall(
  input: ReplyGradeInput
): JudgeCall<typeof replyGradeSchema> {
  return GRADE_CALLS.reply(input);
}

/**
 * The call that asks the judge to grade one whole conversation. The
 * conversation grade eval passes it to `Grader.judge`, so what it sends is
 * what the rubric hash read.
 */
export function conversationCall(
  input: ConversationGradeInput
): JudgeCall<typeof conversationGradeSchema> {
  return GRADE_CALLS.conversation(input);
}

/**
 * The call that asks the judge about one Dream source. The Dream accuracy eval
 * passes it to `Grader.judge`, so what it sends is what the rubric hash read.
 */
export function dreamSourceCall(input: DreamSourceInput): DreamSourceCall {
  return GRADE_CALLS.dreamSource(input);
}

// ---------------------------------------------------------------------------
// The rubric hash
// ---------------------------------------------------------------------------

const RUBRIC_HASH_LENGTH = 10;

/** The schemas the judge answers in. */
const ANSWER_SCHEMAS = {
  conversation: conversationGradeSchema,
  dreamSource: dreamSourceGradeSchema,
  factuality: factualityGradeSchema,
  headToHead: headToHeadSchema,
  reply: replyGradeSchema,
} as const;

/** Stands in for the text a real call carries, so the probe shows where each part goes. */
const PROBE = {
  context: "<fact sheet and journal>",
  label: "probe",
  output: "<output>",
  transcript: "<transcript>",
} as const;

/** A Dream source made of stand-in text, for the Dream-source probe. */
const PROBE_DREAM_SOURCE: DreamSource = {
  sourceId: "probe",
  sourceKind: "entry",
  sourceText: "<source>",
  written: [{ itemKind: "summary", text: "<written>" }],
};

/** The knobs of a grader that change what it grades. */
export interface RubricSettings {
  /** The output cap. */
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Everything the hash covers, as plain data:
 *
 * - every rubric text,
 * - every answer schema, with its fields in the order the judge writes them,
 * - each kind of grade as built from stand-in text: its system prompt, its
 *   item section with the block titles and their order, its schema name, and
 *   the parts of the user message in order,
 * - the fact sheet and journal layout, from stand-in people,
 * - the Dream-source fact sheet and source layout, from stand-in input,
 * - the reply grade's rules for which checks apply to which message, and the
 *   sets of ids it names (its texts are in `rubrics`, its call is in `kinds`),
 * - the temperature and the output cap.
 */
export function rubricMaterial(settings: RubricSettings = {}) {
  const probes = {
    conversation: GRADE_CALLS.conversation(PROBE_CONVERSATION_INPUT),
    dreamSource: dreamSourceProbe(),
    extraction: GRADE_CALLS.extraction({
      ...PROBE,
      current: "<current>",
      stale: "<stale>",
    }),
    factuality: GRADE_CALLS.factuality({
      ...PROBE,
      question: "<question>",
      reference: "<reference>",
    }),
    reply: GRADE_CALLS.reply(PROBE_REPLY_INPUT),
    summary: GRADE_CALLS.summary({ ...PROBE, reference: "<reference>" }),
  };
  return {
    answers: Object.fromEntries(
      // Stringified here, so canonicalJson does not sort the fields.
      Object.entries(ANSWER_SCHEMAS).map(([name, schema]) => [
        name,
        JSON.stringify(z.toJSONSchema(schema)),
      ])
    ),
    conversation: conversationRubricMaterial(),
    dreamSourceLayout: dreamSourceLayout(),
    journalContext: journalContextLayout(),
    kinds: Object.fromEntries(
      Object.entries(probes).map(([kind, call]) => [kind, kindMaterial(call)])
    ),
    maxOutputTokens: settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    reply: replyRubricMaterial(),
    rubrics: RUBRICS,
    temperature: settings.temperature ?? JUDGE_TEMPERATURE,
  };
}

/** The Dream-source call made of stand-in text. */
function dreamSourceProbe(): DreamSourceCall {
  return GRADE_CALLS.dreamSource({
    context: PROBE.context,
    label: PROBE.label,
    source: PROBE_DREAM_SOURCE,
  });
}

/** What one kind of call is made of: its system prompt, item section, prompt parts, and answer format. */
function kindMaterial(call: JudgeCall<z.ZodType>) {
  return {
    instructions: call.instructions,
    item: call.item,
    parts: promptOf(call).parts,
    schema: JSON.stringify(z.toJSONSchema(call.schema)),
    schemaName: call.schemaName,
  };
}

/**
 * A short hash of everything that shapes a grade (see `rubricMaterial`). It
 * goes in the metadata of every graded check, so any change to a prompt, a
 * schema, or a setting shows in the reports.
 */
export function rubricHash(settings: RubricSettings = {}): string {
  return createHash("sha256")
    .update(canonicalJson(rubricMaterial(settings)))
    .digest("hex")
    .slice(0, RUBRIC_HASH_LENGTH);
}

/**
 * Everything that shapes a Dream-source grade and nothing else: its rubric
 * text and answer format, its prompt as built from stand-in text, the fact
 * sheet and source layout, the temperature, and the output cap.
 */
export function dreamSourceMaterial(settings: RubricSettings = {}) {
  return {
    kind: kindMaterial(dreamSourceProbe()),
    layout: dreamSourceLayout(),
    maxOutputTokens: settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: settings.temperature ?? JUDGE_TEMPERATURE,
  };
}

/**
 * A short hash of `dreamSourceMaterial`. The Dream grade cache is named by it,
 * so a change to the reply rubric, which Dream never sees, does not throw away
 * the Dream grades. The rubric hash still goes in the metadata of every check.
 */
export function dreamSourceRubricHash(settings: RubricSettings = {}): string {
  return createHash("sha256")
    .update(canonicalJson(dreamSourceMaterial(settings)))
    .digest("hex")
    .slice(0, RUBRIC_HASH_LENGTH);
}

/** Builds a grader. Nothing is read or called until the first `judge`. */
export function createGrader(options: GraderOptions): Grader {
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const rubric = rubricHash({ maxOutputTokens });
  const dreamRubric = dreamSourceRubricHash({ maxOutputTokens });
  let model: LanguageModel | undefined = options.model;
  let price: Promise<ModelPrice> | undefined;

  const getPrice = (): Promise<ModelPrice> => {
    if (options.price !== undefined) {
      return Promise.resolve(options.price);
    }
    price ??= loadPrices([options.modelId], {
      cacheFile: priceCacheFile(options.runDir),
    }).then((prices) => {
      const found = prices[options.modelId];
      if (found === undefined) {
        throw new Error(`no price for ${options.modelId}`);
      }
      return found;
    });
    return price;
  };

  const settleQuietly = (
    id: string,
    amount: Parameters<typeof settle>[2]
  ): void => {
    try {
      settle(options.runDir, id, amount);
    } catch {
      // The estimate stays reserved, which only makes the ledger cautious.
    }
  };

  /**
   * Settles a call that threw. A call that came back unparseable is billed for
   * its tokens, and a call that failed outright (a refused key, a bad request)
   * cost nothing. A timeout may have been billed for work we never saw, so its
   * estimate stays reserved.
   */
  const settleFailure = (
    id: string,
    error: unknown,
    modelPrice: ModelPrice
  ): void => {
    if (isTimeout(error)) {
      return;
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      if (error.usage?.inputTokens === undefined) {
        return;
      }
      const usage = tokenUsageOf(error.usage);
      settleQuietly(id, {
        ...usage,
        costUsd: costUsd(modelPrice, usage),
        model: options.modelId,
      });
      return;
    }
    settleQuietly(id, {
      costUsd: 0,
      inputTokens: 0,
      model: options.modelId,
      outputTokens: 0,
    });
  };

  const judge = async <S extends z.ZodType>(
    call: JudgeCall<S>
  ): Promise<JudgeOutcome<z.output<S>>> => {
    if (options.unavailable !== undefined) {
      return { ok: false, reason: options.unavailable };
    }
    let modelPrice: ModelPrice;
    try {
      modelPrice = await getPrice();
    } catch (error) {
      return {
        ok: false,
        reason: notGradedReason(
          `not graded: no price for ${options.modelId} (${messageOf(error)})`
        ),
      };
    }
    const prompt = promptOf(call);
    let reservation: ReturnType<typeof reserve>;
    try {
      reservation = reserve(options.runDir, options.capUsd, {
        estimateUsd: estimateUsd(modelPrice, {
          outputTokens: Math.min(
            call.expectedOutputTokens ?? maxOutputTokens,
            maxOutputTokens
          ),
          promptChars: prompt.chars,
        }),
        label: call.label,
        model: options.modelId,
      });
    } catch (error) {
      return {
        ok: false,
        reason: notGradedReason(
          `not graded: spending ledger error (${messageOf(error)})`
        ),
      };
    }
    if (!reservation.ok) {
      return { ok: false, reason: NOT_GRADED_SPENDING_CAP };
    }

    try {
      model ??= createGateway()(options.modelId);
      const result = await generateText({
        maxOutputTokens,
        maxRetries: MAX_RETRIES,
        messages: [
          {
            content: prompt.parts.map((text) => ({
              text,
              type: "text" as const,
            })),
            role: "user",
          },
        ],
        model,
        output: Output.object({
          name: call.schemaName,
          schema: call.schema,
        }),
        providerOptions: {
          gateway: {
            caching: "auto",
            ...(options.routing === undefined
              ? {}
              : {
                  only: [...options.routing.only],
                  order: [...options.routing.order],
                }),
            tags: [TAG_SAGE_EVAL, options.sweepId],
          },
        },
        system: call.instructions,
        temperature: options.temperature ?? JUDGE_TEMPERATURE,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const usage = tokenUsageOf(result.usage);
      const cost =
        gatewayCost(result.providerMetadata) ?? costUsd(modelPrice, usage);
      settleQuietly(reservation.id, {
        ...usage,
        costUsd: cost,
        model: options.modelId,
      });
      return {
        callId: reservation.id,
        costUsd: cost,
        ok: true,
        usage,
        value: result.output as z.output<S>,
      };
    } catch (error) {
      settleFailure(reservation.id, error, modelPrice);
      return {
        ...(NoObjectGeneratedError.isInstance(error)
          ? { noObject: true as const }
          : {}),
        ok: false,
        reason: notGradedReason(`not graded: judge error: ${messageOf(error)}`),
      };
    }
  };

  const grade = async (
    call: JudgeCall<typeof factualityGradeSchema>
  ): Promise<Graded> => {
    const outcome = await judge(call);
    if (!outcome.ok) {
      return {
        evidence: "",
        model: options.modelId,
        notGraded: true,
        pass: null,
        reason: outcome.reason,
        rubric,
      };
    }
    return {
      callId: outcome.callId,
      costUsd: outcome.costUsd,
      evidence: outcome.value.evidence,
      model: options.modelId,
      notGraded: false,
      pass: outcome.value.pass,
      reason: outcome.value.reason,
      rubric,
    };
  };

  return {
    dreamRubric,
    extraction: (input) => grade(GRADE_CALLS.extraction(input)),
    factuality: (input) => grade(GRADE_CALLS.factuality(input)),
    judge,
    modelId: options.modelId,
    rubric,
    summary: (input) => grade(GRADE_CALLS.summary(input)),
  };
}

// ---------------------------------------------------------------------------
// The grader a pass uses
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The grader for this pass, from the variables the runner set: the judge
 * model and the spending cap come from the sweep file, the ledger lives in
 * `SAGE_EVAL_RUN_DIR`, and the sweep id (for the request tags) is
 * `SAGE_EVAL_SWEEP_ID`, else the name of the run directory.
 *
 * Without a run directory there is nowhere to count the spending, so this
 * grader makes no calls and every item comes back "not graded". It never
 * throws, because eve imports every eval file before it filters them.
 */
export function graderFromEnv(env: Env = process.env): Grader {
  const pass = readPassEnv(env);
  let sweepSettings: ReturnType<typeof readPassSweep>;
  try {
    sweepSettings = readPassSweep(env);
  } catch (error) {
    return createGrader({
      capUsd: 0,
      modelId: "unknown",
      runDir: pass.runDir ?? ".",
      sweepId: "unknown",
      unavailable: notGradedReason(
        `not graded: could not read the sweep (${messageOf(error)})`
      ),
    });
  }
  const { runDir } = pass;
  const sweepId = env.SAGE_EVAL_SWEEP_ID?.trim();
  return createGrader({
    capUsd: sweepSettings.spendingCapUsd,
    modelId: sweepSettings.judge.model,
    runDir: runDir ?? ".",
    sweepId:
      sweepId !== undefined && sweepId.length > 0
        ? sweepId
        : basename(runDir ?? "unknown"),
    unavailable:
      runDir === undefined
        ? `not graded: no run directory for the spending ledger (set ${ENV_RUN_DIR}; make eval does)`
        : undefined,
  });
}

let shared: Grader | undefined;

/** The grader for this process, built once from the environment. */
export function sharedGrader(): Grader {
  shared ??= graderFromEnv();
  return shared;
}

export function gradeFactuality(
  input: FactualityInput,
  grader: Grader = sharedGrader()
): Promise<Graded> {
  return grader.factuality(input);
}

export function gradeSummary(
  input: SummaryInput,
  grader: Grader = sharedGrader()
): Promise<Graded> {
  return grader.summary(input);
}

export function gradeExtraction(
  input: ExtractionInput,
  grader: Grader = sharedGrader()
): Promise<Graded> {
  return grader.extraction(input);
}
