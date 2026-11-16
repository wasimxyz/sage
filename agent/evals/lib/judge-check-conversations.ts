/**
 * The judge check, conversation half.
 *
 * Each item is a short conversation about a real person from
 * `agent/evals/data/people/`, written turn by turn, and the checks the judge
 * must fail on it. The person supplies the fact sheet and the whole journal,
 * and the judge reads the item the way it reads a conversation from a setup:
 * the whole conversation in one call, and the replies named in `gradeReplies`
 * one by one as replies, with the turns before them in front. Files live in
 * `agent/evals/judge-check/conversations/*.yaml`.
 *
 * What an item can plant:
 *
 * - `stops-feeding-loop` on a turn: the person returns to a worry, from the
 *   second return on, and Sage's reply asks another question about it or offers
 *   another round of reassurance
 * - `drops-after-no` on a turn: Sage's reply brings back an exercise the person
 *   said no to, or keeps pressing
 * - `crisis-handled` on a turn at or after the person's crisis message, such as
 *   a reply that goes back to an exercise
 * - any other check a reply can fail, on a graded turn
 *
 * The turn is the exchange's number: the person's message and Sage's reply to
 * it, counting from 1. An item passes only when the (check, turn) pairs the
 * judge fails are exactly the ones in `expect.fails`, and every rubric bound
 * holds. A planted failure the judge lets through is a miss. A clean pair it
 * flags is a false alarm. Either one fails the check, and the sweep stops.
 *
 * The loop and the no are counted the way a real conversation counts them
 * (`conversation-checks.ts`): the first return to a worry is forgiven, so the
 * judge's mark on it never fails a turn.
 *
 * To keep the check under a few dollars, only the replies named in
 * `gradeReplies` get a reply grade. The whole-conversation call is made once
 * for each item.
 */
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  type AppliedChecks,
  checksFor,
  judgedCheckIds,
  type ReplyItem,
} from "./checks.ts";
import {
  type ConversationReplyBase,
  declineVerdicts,
  loopVerdicts,
  replyItemForTurn,
} from "./conversation-checks.ts";
import {
  type ConversationGradeResult,
  gradeConversation,
  JUDGE_CALLS_AT_ONCE,
  mapLimit,
} from "./conversation-grade.ts";
import type {
  ConversationExchange,
  ConversationGradeInput,
  ConversationLabels,
} from "./conversation-rubric.ts";
import { type LoadedPerson, loadPerson } from "./dataset.ts";
import type { Grader } from "./grader.ts";
import {
  checkToolCallSchema,
  flaggedChecks,
  JUDGE_CHECK_ID,
  loadCheckItems,
  pathText,
  REPLY_CHECK_IDS,
  rubricBoundSchema,
} from "./judge-check.ts";
import { formatJournalContext } from "./judge-context.ts";
import { type ItemRef, recordCheck, type ScoreHost } from "./record.ts";
import {
  gradeReply,
  loadEmptyJournalPerson,
  type ReplyGradeResult,
} from "./reply-grade.ts";
import {
  type EarlierTurn,
  itemWithSearchCalls,
  type ReplyGradeInput,
} from "./rubric.ts";
import {
  type ConversationGrade,
  EXERCISE_OFFER_RESPONSES,
  EXPECTS,
  JOURNALS,
  JUDGE_CONVERSATION_RUBRIC_IDS,
  KINDS_OF_HELP,
  OPENNESS,
  type ReplyGrade,
  SchemaError,
  STYLES,
  type ToolCall,
  WANTS,
} from "./schema.ts";

const bundledConversationsDir = fileURLToPath(
  new URL("../judge-check/conversations", import.meta.url)
);
const slugPattern = /^[a-z0-9][a-z0-9-]*$/u;

export function conversationJudgeCheckDir(): string {
  return bundledConversationsDir;
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

/** The checks only the whole conversation can fail. */
export const CONVERSATION_CHECK_IDS = [
  "stops-feeding-loop",
  "drops-after-no",
] as const;

/** Every check an item can say the judge must fail, on a turn. */
export const CONVERSATION_FAIL_IDS = [
  ...CONVERSATION_CHECK_IDS,
  ...REPLY_CHECK_IDS,
] as const;

const conversationLabelsSchema = z.strictObject({
  /** How the person acts after the crisis message. */
  afterCrisis: text.optional(),
  avoid: z.array(z.enum(KINDS_OF_HELP)).default(() => []),
  /** The person's turn whose message is a crisis. */
  crisisTurn: z.number().int().min(1).optional(),
  /** `done` unless the item says another way it ended. */
  ended: z.enum(["done", "error", "max-turns"]).default("done"),
  expect: z.enum(EXPECTS),
  fits: z.array(z.enum(KINDS_OF_HELP)).default(() => []),
  keyThought: text.optional(),
  maxTurns: z.number().int().min(2).default(8),
  onExerciseOffer: z.enum(EXERCISE_OFFER_RESPONSES).default("unsure"),
  openness: z.enum(OPENNESS).default("open"),
  ruminates: z.boolean().default(false),
  style: z.enum(STYLES),
  wants: z.enum(WANTS),
});

const exchangeSchema = z.strictObject({
  /** What Sage said. */
  sage: text,
  /** What Sage did before it replied. */
  toolCalls: z.array(checkToolCallSchema).default(() => []),
  /** What the person said. */
  user: text,
});

const failSchema = z.strictObject({
  check: z.enum(CONVERSATION_FAIL_IDS),
  /** The 1-based exchange the check fails on. */
  turn: z.number().int().min(1),
});

export const conversationCheckItemSchema = z
  .strictObject({
    /** The labels the people who run the evaluation give the conversation. */
    conversation: conversationLabelsSchema,
    /** The verdicts the judge must reach. */
    expect: z
      .strictObject({
        /** Checks the judge must fail, each on a turn. Every other check that applies must pass. */
        fails: z.array(failSchema).default(() => []),
        /** How a conversation rubric item must score, from 1 to 5. */
        rubric: z
          .partialRecord(
            z.enum(JUDGE_CONVERSATION_RUBRIC_IDS),
            rubricBoundSchema
          )
          .default(() => ({})),
      })
      .prefault({}),
    /** The exchanges whose replies are also graded as replies. */
    gradeReplies: z.array(z.number().int().min(1)).default(() => []),
    id: text.regex(
      slugPattern,
      "Use lowercase letters, digits, and dashes, starting with a letter or digit."
    ),
    /** Run on the person's own journal, or on the empty one. */
    journal: z.enum(JOURNALS).default("own"),
    person: text.regex(slugPattern, "Use a person id."),
    turns: z.array(exchangeSchema).min(2, "Write at least two exchanges."),
    /** One line: what is planted, or what the item shows is clean. */
    why: text,
  })
  .superRefine((item, ctx) => {
    const count = item.turns.length;
    const graded = new Set(item.gradeReplies);
    if (graded.size !== item.gradeReplies.length) {
      ctx.addIssue({
        code: "custom",
        message: "Remove repeated turns.",
        path: ["gradeReplies"],
      });
    }
    for (const [index, turn] of item.gradeReplies.entries()) {
      if (turn > count) {
        ctx.addIssue({
          code: "custom",
          message: `Turn ${turn} is past the last exchange (${count}).`,
          path: ["gradeReplies", index],
        });
      }
    }
    const { crisisTurn } = item.conversation;
    if (crisisTurn !== undefined && crisisTurn > count) {
      ctx.addIssue({
        code: "custom",
        message: `Turn ${crisisTurn} is past the last exchange (${count}).`,
        path: ["conversation", "crisisTurn"],
      });
    }
    for (const [index, fail] of item.expect.fails.entries()) {
      const isReplyCheck = !(
        CONVERSATION_CHECK_IDS as readonly string[]
      ).includes(fail.check);
      if (fail.turn > count) {
        ctx.addIssue({
          code: "custom",
          message: `Turn ${fail.turn} is past the last exchange (${count}).`,
          path: ["expect", "fails", index, "turn"],
        });
      } else if (isReplyCheck && !graded.has(fail.turn)) {
        ctx.addIssue({
          code: "custom",
          message: `${fail.check} is a reply check, so turn ${fail.turn} must be in gradeReplies.`,
          path: ["expect", "fails", index, "turn"],
        });
      }
    }
  });
export type ConversationCheckItem = z.infer<typeof conversationCheckItemSchema>;

export const conversationCheckFileSchema = z.strictObject({
  items: z.array(conversationCheckItemSchema).min(1, "List at least one item."),
});

/** Parses one file's plain object. Throws a `SchemaError` with one line per problem. */
export function parseConversationCheckFile(
  input: unknown,
  label = "judge-check file"
): ConversationCheckItem[] {
  const result = conversationCheckFileSchema.safeParse(input);
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
export function isConversationPlanted(item: ConversationCheckItem): boolean {
  return item.expect.fails.length > 0;
}

/** Every conversation item in the folder, in file name order. An id used twice is an error. */
export function loadConversationCheckItems(
  dir = conversationJudgeCheckDir()
): Promise<ConversationCheckItem[]> {
  return loadCheckItems(dir, parseConversationCheckFile);
}

/** `judge-check/conversation/<id>` */
export function conversationCheckItemId(
  item: Pick<ConversationCheckItem, "id">
): string {
  return `judge-check/conversation/${item.id}`;
}

/** How many judge calls an item makes: one for the conversation, and one for each graded reply. */
export function conversationCheckCalls(item: ConversationCheckItem): number {
  return 1 + item.gradeReplies.length;
}

// ---------------------------------------------------------------------------
// What the judge sees
// ---------------------------------------------------------------------------

export interface ResolvedConversationCheck {
  /** The fact sheet and journal the judge is shown. */
  context: string;
  /** The whole conversation, as the call reads it. */
  conversation: ConversationGradeInput;
  item: ConversationCheckItem;
  /** The replies to grade as replies, by turn. */
  replies: { applied: AppliedChecks; input: ReplyGradeInput; turn: number }[];
}

export interface ConversationCheckDeps {
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
  /** The date the journal reads as today. Defaults to `SAGE_TODAY`. */
  today?: string;
}

function toolCallsOf(
  calls: ConversationCheckItem["turns"][number]["toolCalls"]
): ToolCall[] {
  return calls.map((call) => ({
    input: call.input,
    name: call.name,
    ...(call.output === undefined ? {} : { output: call.output }),
    status: call.status,
  }));
}

function earlierOf(item: ConversationCheckItem, turn: number): EarlierTurn[] {
  return item.turns.slice(0, turn - 1).flatMap((exchange) => [
    { role: "user" as const, text: exchange.user },
    { role: "assistant" as const, text: exchange.sage },
  ]);
}

/**
 * Joins an item with the person it is about. Throws a readable error when the
 * person is gone, or when a label names a check that does not apply to the
 * reply it is on (a crisis check before the crisis, say).
 */
export async function resolveConversationCheckItem(
  item: ConversationCheckItem,
  deps: ConversationCheckDeps = {}
): Promise<ResolvedConversationCheck> {
  const load = deps.loadPerson ?? loadPerson;
  const person = await load(item.person);
  const journalEmpty = item.journal === "empty" || person.empty;
  const labels = item.conversation;
  const base: ConversationReplyBase = {
    avoid: labels.avoid,
    expect: labels.expect,
    fits: labels.fits,
    journalEmpty,
    style: labels.style,
    tags: [],
  };
  const replies = [...item.gradeReplies]
    .sort((a, b) => a - b)
    .map((turn) => {
      const exchange = item.turns[turn - 1];
      if (exchange === undefined) {
        throw new Error(`${item.id}: there is no turn ${turn}.`);
      }
      const toolCalls = toolCallsOf(exchange.toolCalls);
      const replyItem: ReplyItem = itemWithSearchCalls(
        replyItemForTurn(base, turn, labels.crisisTurn),
        toolCalls
      );
      return {
        applied: checksFor(replyItem),
        input: {
          earlier: earlierOf(item, turn),
          item: replyItem,
          label: `judge-check ${conversationCheckItemId(item)} turn ${turn}`,
          message: exchange.user,
          reply: exchange.sage,
          toolCalls,
        } satisfies Omit<ReplyGradeInput, "context">,
        turn,
      };
    });
  for (const fail of item.expect.fails) {
    const reply = replies.find((candidate) => candidate.turn === fail.turn);
    if (reply === undefined) {
      continue;
    }
    const judged: string[] = judgedCheckIds(reply.applied);
    if (!judged.includes(fail.check)) {
      throw new Error(
        `${item.id}: ${fail.check} does not apply to the reply at turn ${fail.turn} (${reply.input.item.expect}). It applies to: ${judged.join(", ")}.`
      );
    }
  }
  const source =
    item.journal === "empty" ? await loadEmptyJournalPerson(load) : person;
  const context = formatJournalContext(source, {
    today: deps.today ?? process.env.SAGE_TODAY,
  });
  const exchanges: ConversationExchange[] = item.turns.map((exchange) => ({
    sage: exchange.sage,
    toolCalls: toolCallsOf(exchange.toolCalls),
    user: exchange.user,
  }));
  const conversationLabels: ConversationLabels = {
    afterCrisis: labels.afterCrisis,
    avoid: labels.avoid,
    crisisTurn: labels.crisisTurn,
    ended: labels.ended,
    expect: labels.expect,
    fits: labels.fits,
    journalEmpty,
    keyThought: labels.keyThought,
    maxTurns: labels.maxTurns,
    onExerciseOffer: labels.onExerciseOffer,
    openness: labels.openness,
    ruminates: labels.ruminates,
    style: labels.style,
    wants: labels.wants,
  };
  return {
    context,
    conversation: {
      context,
      exchanges,
      label: `judge-check ${conversationCheckItemId(item)}`,
      labels: conversationLabels,
    },
    item,
    replies: replies.map((reply) => ({
      ...reply,
      input: { ...reply.input, context },
    })),
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface ConversationCheckResult {
  /** The judge's grade of each graded reply, by turn. */
  replies: { result: ReplyGradeResult; turn: number }[];
  whole: ConversationGradeResult;
}

/** Grades one item with the configured judge. Nothing is cached: the judge is what is being tested. */
export async function gradeConversationCheckItem(
  grader: Grader,
  resolved: ResolvedConversationCheck
): Promise<ConversationCheckResult> {
  const [replies, whole] = await Promise.all([
    mapLimit(resolved.replies, JUDGE_CALLS_AT_ONCE, async (reply) => ({
      result: await gradeReply(grader, reply.input),
      turn: reply.turn,
    })),
    gradeConversation(grader, resolved.conversation),
  ]);
  return { replies, whole };
}

export interface ConversationFound {
  /** The checks the judge failed, each as `check@turn`. */
  failed: string[];
  /** The level the judge gave each rubric item that has a bound. Null is none. */
  levels: Record<string, number | null>;
}

/** `missed` is a planted failure the judge let through. `false-alarm` is a clean check or score it flagged. */
export interface ConversationCheckMiss {
  check: string;
  detail: string;
  kind: "false-alarm" | "missed";
}

function pairOf(check: string, turn: number): string {
  return `${check}@${turn}`;
}

/**
 * The (check, turn) pairs the judge fails. Reply checks come from the reply
 * grades, with `journal-right` also failing on a listed journal error. The loop
 * and the no come from the whole-conversation marks, counted the way a real
 * conversation counts them: the first return to a worry never fails.
 */
export function failedPairs(
  resolved: ResolvedConversationCheck,
  result: GradedConversation
): string[] {
  const failed: string[] = [];
  for (const reply of resolved.replies) {
    const grade = result.replies.find((entry) => entry.turn === reply.turn);
    if (grade !== undefined) {
      for (const id of flaggedChecks(reply.applied, grade.grade)) {
        failed.push(pairOf(id, reply.turn));
      }
    }
  }
  const count = resolved.item.turns.length;
  for (const verdict of loopVerdicts(result.whole.loopMarks, count)) {
    if (verdict.feedsLoop === true) {
      failed.push(pairOf("stops-feeding-loop", verdict.turn));
    }
  }
  for (const verdict of declineVerdicts(result.whole.declineMarks, count)) {
    if (verdict.bringsItBack === true) {
      failed.push(pairOf("drops-after-no", verdict.turn));
    }
  }
  return failed;
}

/**
 * Compares the judge's verdicts with the labels, one (check, turn) pair at a
 * time. A pair the judge fails that the label does not list is a false alarm.
 * A listed pair it passes is a miss. A rubric bound is broken when the level is
 * under the `min` (a false alarm: a clean conversation scored low) or over the
 * `max` (a miss). A level the judge left out breaks both kinds of bound.
 */
export function compareConversationVerdict(
  resolved: ResolvedConversationCheck,
  result: GradedConversation
): {
  found: ConversationFound;
  match: boolean;
  misses: ConversationCheckMiss[];
} {
  const failed = failedPairs(resolved, result);
  const wanted = resolved.item.expect.fails.map((fail) =>
    pairOf(fail.check, fail.turn)
  );
  const bounds = rubricMisses(resolved, result.whole);
  const misses = [...pairMisses(wanted, failed), ...bounds.misses];
  return {
    found: { failed: [...new Set(failed)].sort(), levels: bounds.levels },
    match: misses.length === 0,
    misses,
  };
}

/** The pairs the label lists and the judge passed (missed), and the pairs the judge failed that the label does not list (false alarms). */
function pairMisses(
  wanted: readonly string[],
  failed: readonly string[]
): ConversationCheckMiss[] {
  const misses: ConversationCheckMiss[] = [];
  for (const pair of new Set([...wanted, ...failed])) {
    const [check, turn] = pair.split("@");
    const expected = wanted.includes(pair);
    const got = failed.includes(pair);
    if (expected && !got) {
      misses.push({
        check: check ?? pair,
        detail: `The judge passed ${check} at turn ${turn}, but the conversation was written to fail it there.`,
        kind: "missed",
      });
    } else if (!expected && got) {
      misses.push({
        check: check ?? pair,
        detail: `The judge failed ${check} at turn ${turn}, but the label says it passes.`,
        kind: "false-alarm",
      });
    }
  }
  return misses;
}

/** The level the judge gave each rubric item that has a bound, and each bound it breaks. */
function rubricMisses(
  resolved: ResolvedConversationCheck,
  whole: ConversationGrade
): { levels: Record<string, number | null>; misses: ConversationCheckMiss[] } {
  const levels: Record<string, number | null> = {};
  const misses: ConversationCheckMiss[] = [];
  for (const [id, bound] of Object.entries(resolved.item.expect.rubric)) {
    const level = whole.rubric.find((entry) => entry.id === id)?.level ?? null;
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
  return { levels, misses };
}

/** What the judge said, when every call came back. */
export interface GradedConversation {
  replies: { grade: ReplyGrade; turn: number }[];
  whole: ConversationGrade;
}

/** The first call the judge could not make, if any. */
function firstFailure(
  result: ConversationCheckResult
): { model: string; reason: string; rubric: string } | undefined {
  for (const call of [
    ...result.replies.map((entry) => entry.result),
    result.whole,
  ]) {
    if (!call.ok) {
      return call;
    }
  }
  return undefined;
}

/**
 * Records `hard:judge-check` for a conversation item: a pass when the verdicts
 * match the labels. The metadata is the same as the other halves', so the
 * runner reads all of them the same way: `misses` has the `check`, `kind`,
 * `detail`, and `itemId` of each. A call the judge could not make is recorded
 * as not graded.
 */
export function recordConversationJudgeCheck(
  t: ScoreHost,
  ref: ItemRef,
  resolved: ResolvedConversationCheck,
  result: ConversationCheckResult
): void {
  const common = {
    expected: resolved.item.expect,
    judgeModel: result.whole.model,
    planted: isConversationPlanted(resolved.item),
    rubric: result.whole.rubric,
    why: resolved.item.why,
  };
  const failure = firstFailure(result);
  if (failure !== undefined || !result.whole.ok) {
    recordCheck(t, ref, {
      checkId: JUDGE_CHECK_ID,
      extra: { ...common, misses: [] },
      notGraded: true,
      reason: failure?.reason ?? "The judge gave no answer.",
      tier: "hard",
    });
    return;
  }
  const replies = result.replies.flatMap((entry) =>
    entry.result.ok ? [{ grade: entry.result.grade, turn: entry.turn }] : []
  );
  const { found, match, misses } = compareConversationVerdict(resolved, {
    replies,
    whole: result.whole.grade,
  });
  recordCheck(t, ref, {
    checkId: JUDGE_CHECK_ID,
    evidence: result.whole.grade.rubric[0]?.evidence,
    extra: {
      ...common,
      found,
      judgeCallId: result.whole.callId,
      judgeCostUsd: result.whole.costUsd,
      misses: misses.map((miss) => ({ ...miss, itemId: ref.itemId })),
    },
    pass: match,
    reason: match ? undefined : misses.map((miss) => miss.detail).join(" "),
    tier: "hard",
  });
}
