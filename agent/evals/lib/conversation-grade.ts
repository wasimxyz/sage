/**
 * Grading conversations.
 *
 * `grade/conversations.eval.ts` makes one eval for each conversation in the
 * transcripts. Inside it, the judge is asked:
 *
 * - once for each Sage reply, as a reply (`reply-grade.ts`), with the turns
 *   before it in front and the labels of that turn: its `expect` (the
 *   conversation's, or the scripted turn's own), the conversation's `fits` and
 *   `avoid`, and its `search`. From the crisis turn on, the labels say
 *   `crisis`, so `crisis-handled` applies to that reply and every later one,
 *   and to none before it. `conversation-checks.ts` has the rules.
 * - once for the whole conversation (`conversation-rubric.ts`). It scores
 *   `follows-lead`, `collaboration`, and `keeps-track`, marks the exchanges
 *   where the person returns to a worry or has said no to something, and flags
 *   the simulated user's messages after a crisis that went soft.
 *
 * Code turns the marks into the counted checks (`conversation-checks.ts`):
 * `stops-feeding-loop` from the second return on, and `drops-after-no` after
 * each no. It records them on the exchange's reply. The search checks and the
 * slips a pattern catches run on every reply, with no judge, as they do for an
 * opener.
 *
 * A conversation whose simulated user went soft after a crisis keeps Sage's
 * crisis grades and counted checks, and is left out of the conversation rubric
 * and of the person's rating. So is one that ended because the simulated user
 * failed, or that was too short to grade as a whole.
 *
 * Everything that touches the world (the people, the transcripts, the judge) is
 * passed in, so the tests run with made-up people and a mock judge.
 */
import { defineEval } from "eve/evals";
import {
  type ConversationReplyBase,
  declineVerdicts,
  type ExchangeRef,
  exchangesOf,
  leftOutReason,
  loopVerdicts,
  MIN_EXCHANGES_TO_GRADE,
  needsForTurn,
  replyItemForTurn,
  simulatedUserFlagMarks,
  turnLabelsOf,
} from "./conversation-checks.ts";
import type {
  ConversationExchange,
  ConversationGradeInput,
  ConversationLabels,
} from "./conversation-rubric.ts";
import { conversationTimeoutMs } from "./conversation-run.ts";
import { conversationTags, splitConversationKey } from "./conversations.ts";
import { type LoadedPerson, loadPerson, type Manifest } from "./dataset.ts";
import { conversationCall, type Grader, sharedGrader } from "./grader.ts";
import { formatJournalContext } from "./judge-context.ts";
import { type EvalDefinition, failEval, guardedEvals } from "./pass.ts";
import {
  type CheckRecord,
  type ItemRef,
  itemMetadata,
  makeItem,
  recordCheck,
  type ScoreHost,
} from "./record.ts";
import {
  emptyJournalStandIn,
  gradeReply,
  loadEmptyJournalPerson,
  manifestReader,
  NO_REPLY_REASON,
  type ReplySettings,
  type ReplyTarget,
  recordPatternSlips,
  recordReplyGrade,
  recordSearchChecks,
  settingsFromEnv,
  uniqueRows,
} from "./reply-grade.ts";
import type { EarlierTurn } from "./rubric.ts";
import { itemWithSearchCalls } from "./rubric.ts";
import {
  type Conversation,
  type ConversationGrade,
  ENV_TODAY,
  JUDGE_CONVERSATION_RUBRIC_IDS,
  parseItemId,
  rubricLevelToScore,
  type SimulatedUserFlag,
  type SimulatedUserFlagMark,
  type TranscriptRow,
} from "./schema.ts";
import { loadTranscripts } from "./transcripts.ts";

// ---------------------------------------------------------------------------
// From a transcript row to what the judge sees
// ---------------------------------------------------------------------------

/** True for the rows this module grades. */
export function isConversationRow(row: TranscriptRow): boolean {
  return row.kind === "conversation";
}

type Owner = Pick<LoadedPerson, "empty" | "id" | "personCase">;

/** The conversation a row is about, from the person who wrote it. Throws when it is not there. */
export function conversationOfRow(
  row: TranscriptRow,
  owner: Owner
): Conversation {
  const parsed = parseItemId(row.itemId);
  if (parsed === null) {
    throw new Error(`${row.itemId} is not an item id.`);
  }
  const { conversationId } = splitConversationKey(parsed.key);
  const conversation = owner.personCase.conversations.find(
    (candidate) => candidate.id === conversationId
  );
  if (conversation === undefined) {
    throw new Error(`${owner.id} has no conversation "${conversationId}".`);
  }
  return conversation;
}

/** The turns before the person's message at `userIndex`, as the judge reads them. */
export function earlierTurns(
  row: TranscriptRow,
  userIndex: number
): EarlierTurn[] {
  return row.turns.slice(0, userIndex).map((turn) => ({
    role: turn.role,
    text: turn.text,
  }));
}

/** One exchange as the conversation call reads it. */
export function exchangeOf(
  row: TranscriptRow,
  ref: ExchangeRef
): ConversationExchange {
  const reply =
    ref.assistantIndex === -1 ? undefined : row.turns[ref.assistantIndex];
  return {
    sage: reply?.text ?? "",
    toolCalls: reply?.toolCalls ?? [],
    user: row.turns[ref.userIndex]?.text ?? "",
  };
}

/** What the replies of a conversation share, from the conversation and its row. */
export function replyBaseOf(
  conversation: Conversation,
  journalEmpty: boolean
): ConversationReplyBase {
  return {
    ...turnLabelsOf(conversation),
    avoid: conversation.avoid,
    fits: conversation.fits,
    journalEmpty,
    openingSearch: conversation.search,
    style: conversation.persona.style,
    tags: conversation.tags,
  };
}

/** What the people who run the evaluation say about a conversation, for the whole-conversation call. */
export function labelsOf(
  conversation: Conversation,
  row: Pick<TranscriptRow, "ended">,
  journalEmpty: boolean
): ConversationLabels {
  const { persona } = conversation;
  return {
    afterCrisis: persona.afterCrisis,
    avoid: conversation.avoid,
    crisisTurn: conversation.crisis?.turn,
    ended: row.ended,
    expect: conversation.expect,
    fits: conversation.fits,
    journalEmpty,
    keyThought: persona.keyThought,
    maxTurns: conversation.maxTurns,
    onExerciseOffer: persona.onExerciseOffer,
    openness: persona.openness,
    ruminates: persona.ruminates,
    style: persona.style,
    wants: persona.wants,
  };
}

/** The reply of one exchange, ready for the reply checks. */
export function targetOfExchange(
  row: TranscriptRow,
  ref: ExchangeRef,
  base: ConversationReplyBase,
  crisisTurn: number | undefined
): ReplyTarget {
  const reply =
    ref.assistantIndex === -1 ? undefined : row.turns[ref.assistantIndex];
  const toolCalls = reply?.toolCalls ?? [];
  return {
    item: itemWithSearchCalls(
      replyItemForTurn(base, ref.n, crisisTurn),
      toolCalls
    ),
    message: row.turns[ref.userIndex]?.text ?? "",
    needs: [...needsForTurn(base, ref.n)],
    reply: reply?.text ?? "",
    replyIndex: ref.assistantIndex,
    toolCalls,
  };
}

// ---------------------------------------------------------------------------
// Asking the judge
// ---------------------------------------------------------------------------

export type ConversationGradeResult =
  | {
      callId: string;
      costUsd: number;
      grade: ConversationGrade;
      model: string;
      ok: true;
      rubric: string;
    }
  | { model: string; ok: false; reason: string; rubric: string };

/** Asks the judge to grade one whole conversation. Never throws. */
export async function gradeConversation(
  grader: Grader,
  input: ConversationGradeInput
): Promise<ConversationGradeResult> {
  const outcome = await grader.judge(conversationCall(input));
  if (!outcome.ok) {
    return {
      model: grader.modelId,
      ok: false,
      reason: outcome.reason,
      rubric: grader.rubric,
    };
  }
  return {
    callId: outcome.callId,
    costUsd: outcome.costUsd,
    grade: outcome.value,
    model: grader.modelId,
    ok: true,
    rubric: grader.rubric,
  };
}

/** Runs `work` on every item, `limit` at a time, and returns the results in order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // biome-ignore lint/performance/noAwaitInLoops: a worker takes one item at a time.
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker)
  );
  return results;
}

/** The most judge calls one conversation has in flight. Several conversations grade at once too. */
export const JUDGE_CALLS_AT_ONCE = 3;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function notGradedReason(id: string): string {
  return `not graded: the judge gave no verdict for ${id}`;
}

/** What the whole-conversation grade needs, apart from the judge's answer. */
export interface ConversationOutcome {
  /** What the judge said about the whole conversation. Left out when no call was made. */
  call?: ConversationGradeResult;
  /** Flags the runner set while the conversation ran. */
  codeFlags: readonly SimulatedUserFlag[];
  crisisTurn: number | undefined;
  ended: TranscriptRow["ended"];
  exchanges: readonly ExchangeRef[];
  /** The text of the person's last message. */
  lastUserText: string;
  /** The simulated user's own rating. */
  userRating?: TranscriptRow["userRating"];
}

/**
 * Whether the whole conversation is worth a judge call: it did not end because
 * the simulated user failed, and it has enough exchanges.
 */
export function worthGradingAsAWhole(
  ended: TranscriptRow["ended"],
  exchangeCount: number
): boolean {
  return (
    leftOutReason({ ended, exchangeCount, flags: [] }) === null &&
    exchangeCount >= MIN_EXCHANGES_TO_GRADE
  );
}

function judgedMeta(call: ConversationGradeResult | undefined) {
  if (call === undefined) {
    return {};
  }
  return call.ok
    ? {
        judgeCallId: call.callId,
        judgeCostUsd: call.costUsd,
        judgeModel: call.model,
        rubric: call.rubric,
      }
    : { judgeModel: call.model, rubric: call.rubric };
}

function loopRecords(
  grade: ConversationGrade,
  exchanges: readonly ExchangeRef[]
): CheckRecord[] {
  return loopVerdicts(grade.loopMarks, exchanges.length).flatMap((verdict) => {
    const turnIndex = exchanges[verdict.turn - 1]?.assistantIndex;
    if (turnIndex === undefined || turnIndex === -1) {
      return [];
    }
    const ungraded = verdict.feedsLoop === null;
    return [
      {
        checkId: "stops-feeding-loop",
        evidence: verdict.evidence,
        extra: { returnNumber: verdict.returnNumber },
        notGraded: ungraded,
        pass: verdict.feedsLoop === false,
        reason: ungraded
          ? notGradedReason("stops-feeding-loop")
          : verdict.reason,
        tier: "counted",
        turnIndex,
      } satisfies CheckRecord,
    ];
  });
}

function declineRecords(
  grade: ConversationGrade,
  exchanges: readonly ExchangeRef[]
): CheckRecord[] {
  return declineVerdicts(grade.declineMarks, exchanges.length).flatMap(
    (verdict) => {
      const turnIndex = exchanges[verdict.turn - 1]?.assistantIndex;
      if (turnIndex === undefined || turnIndex === -1) {
        return [];
      }
      const ungraded = verdict.bringsItBack === null;
      return [
        {
          checkId: "drops-after-no",
          evidence: verdict.evidence,
          notGraded: ungraded,
          pass: verdict.bringsItBack === false,
          reason: ungraded ? notGradedReason("drops-after-no") : verdict.reason,
          tier: "counted",
          turnIndex,
        } satisfies CheckRecord,
      ];
    }
  );
}

function rubricRecord(
  id: (typeof JUDGE_CONVERSATION_RUBRIC_IDS)[number],
  grade: ConversationGrade | undefined,
  reasons: { leftOut: string | null; unavailable: string | undefined },
  marks: Record<string, unknown>
): CheckRecord {
  // The marks ride on one record, so the report reads each of them once.
  const extra = id === "follows-lead" ? marks : undefined;
  const base = { checkId: id, extra, tier: "rubric" } as const;
  if (reasons.leftOut !== null) {
    return {
      ...base,
      notApplicable: true,
      reason: `N/A: left out because ${reasons.leftOut}`,
    };
  }
  const score = grade?.rubric.find((entry) => entry.id === id);
  if (score === undefined || score.level === null) {
    return {
      ...base,
      notGraded: true,
      reason: reasons.unavailable ?? notGradedReason(id),
    };
  }
  return {
    ...base,
    evidence: score.evidence,
    extra: { ...extra, level: score.level },
    reason: score.reason,
    score: rubricLevelToScore(score.level),
  };
}

function userRatingRecord(
  outcome: ConversationOutcome,
  leftOut: string | null
): CheckRecord {
  const base = { checkId: "user-rating", tier: "rubric" } as const;
  if (leftOut !== null) {
    return {
      ...base,
      notApplicable: true,
      reason: `N/A: left out because ${leftOut}`,
    };
  }
  if (outcome.userRating === undefined) {
    return {
      ...base,
      notApplicable: true,
      reason: "N/A: the simulated user gave no rating",
    };
  }
  return {
    ...base,
    extra: { level: outcome.userRating.level },
    reason: outcome.userRating.reason,
    score: rubricLevelToScore(outcome.userRating.level),
  };
}

/**
 * Records the checks that need the whole conversation:
 *
 * - `counted:stops-feeding-loop`, from the second return on, and
 *   `counted:drops-after-no`, after each no, each on the reply it is about.
 *   A mark with no verdict is not graded.
 * - the rubric `follows-lead`, `collaboration`, and `keeps-track`, and the
 *   simulated user's `user-rating`. All four are N/A when the conversation is
 *   left out (see `leftOutReason`), and not graded when the judge could not
 *   score them.
 *
 * The judge's marks and the final flags go on `follows-lead`, so the report
 * holds each once. A judge that could not answer leaves the rubric not graded
 * and records no counted check, because without its marks no exchange is known
 * to qualify.
 */
export function recordConversationGrade(
  t: ScoreHost,
  ref: ItemRef,
  outcome: ConversationOutcome
): void {
  const { call } = outcome;
  const grade = call?.ok === true ? call.grade : undefined;
  const flags: SimulatedUserFlagMark[] = simulatedUserFlagMarks({
    codeFlags: outcome.codeFlags,
    crisisTurn: outcome.crisisTurn,
    exchangeCount: outcome.exchanges.length,
    judged: grade?.simulatedUserFlags ?? [],
    lastUserText: outcome.lastUserText,
  });
  const leftOut = leftOutReason({
    ended: outcome.ended,
    exchangeCount: outcome.exchanges.length,
    flags,
  });
  const judged = judgedMeta(call);
  // Every record names the call, even an N/A one, so the call's cost is counted
  // once however the checks turn out.
  const record = (check: CheckRecord): void => {
    recordCheck(t, ref, { ...check, extra: { ...judged, ...check.extra } });
  };
  if (grade !== undefined) {
    for (const check of [
      ...loopRecords(grade, outcome.exchanges),
      ...declineRecords(grade, outcome.exchanges),
    ]) {
      record(check);
    }
  }
  const marks: Record<string, unknown> = {
    simulatedUserFlags: flags,
    ...(grade === undefined
      ? {}
      : { declineMarks: grade.declineMarks, loopMarks: grade.loopMarks }),
  };
  const unavailable = call?.ok === false ? call.reason : undefined;
  for (const id of JUDGE_CONVERSATION_RUBRIC_IDS) {
    record(rubricRecord(id, grade, { leftOut, unavailable }, marks));
  }
  record(userRatingRecord(outcome, leftOut));
}

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

export interface ConversationGradeDeps {
  env?: Env;
  grader?: Grader;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
  /** Reads the generated transcripts. Defaults to `SAGE_EVAL_TRANSCRIPTS`. */
  loadTranscripts?: () => TranscriptRow[];
  /** Reads the seed step's manifest of ids. Defaults to the file `SAGE_EVAL_MANIFEST` names. */
  manifest?: () => Manifest | undefined;
  /** What the checks that need no judge read. Defaults to the sweep file and setup of the pass. */
  settings?: ReplySettings;
}

/** What each eval of the pass shares. */
interface Shared {
  contextFor: (row: TranscriptRow, owner: LoadedPerson) => string;
  deps: ConversationGradeDeps;
  manifest: () => Manifest | undefined;
  settings: ReplySettings;
}

function hasReplyText(row: TranscriptRow, ref: ExchangeRef): boolean {
  const reply =
    ref.assistantIndex === -1 ? undefined : row.turns[ref.assistantIndex];
  return (
    reply !== undefined && reply.error === undefined && reply.text.trim() !== ""
  );
}

function conversationEval(
  row: TranscriptRow,
  owner: LoadedPerson,
  shared: Shared
): EvalDefinition {
  let conversation: Conversation;
  try {
    conversation = conversationOfRow(row, owner);
  } catch (error) {
    return failEval(`${row.itemId} (judge)`, error);
  }
  const ref = makeItem(
    {
      expect: conversation.expect,
      itemId: row.itemId,
      kind: "conversation",
      person: row.person,
    },
    row.setupId,
    row.repeat
  );
  const journalEmpty = row.journal === "empty" || owner.empty;
  const base = replyBaseOf(conversation, journalEmpty);
  const crisisTurn = conversation.crisis?.turn;
  const exchanges = exchangesOf(row.turns);
  return defineEval({
    description: `${row.itemId}: conversation grade (judge)${row.repeat > 1 ? ` (repeat ${row.repeat})` : ""}`,
    metadata: itemMetadata(ref),
    tags: conversationTags({ conversation, journal: row.journal, owner }),
    async test(t) {
      const targets = exchanges.map((exchange) => ({
        earlier: earlierTurns(row, exchange.userIndex),
        ref: exchange,
        target: targetOfExchange(row, exchange, base, crisisTurn),
      }));
      const withTurn = targets.filter(
        (job) =>
          job.ref.assistantIndex !== -1 &&
          (hasReplyText(row, job.ref) || job.target.toolCalls.length > 0)
      );
      if (withTurn.length === 0) {
        t.skip(NO_REPLY_REASON);
        return;
      }
      // The checks that need no judge come first, so they are there even when
      // the judge fails.
      for (const job of withTurn) {
        recordSearchChecks(
          t,
          ref,
          job.target.replyIndex,
          job.target,
          owner,
          shared.settings,
          shared.manifest()
        );
        if (hasReplyText(row, job.ref)) {
          recordPatternSlips(
            t,
            ref,
            job.target.replyIndex,
            job.target.reply,
            job.target.item.expect,
            shared.settings
          );
        }
      }
      const grader = shared.deps.grader ?? sharedGrader();
      const context = shared.contextFor(row, owner);
      const graded = withTurn.filter((job) => hasReplyText(row, job.ref));
      const whole = worthGradingAsAWhole(row.ended, exchanges.length);
      const [replies, call] = await Promise.all([
        mapLimit(graded, JUDGE_CALLS_AT_ONCE, (job) =>
          gradeReply(grader, {
            context,
            earlier: job.earlier,
            item: job.target.item,
            label: `reply ${row.itemId} turn ${job.ref.n}`,
            message: job.target.message,
            reply: job.target.reply,
            toolCalls: job.target.toolCalls,
          })
        ),
        whole
          ? gradeConversation(grader, {
              context,
              exchanges: exchanges.map((exchange) => exchangeOf(row, exchange)),
              label: `conversation ${row.itemId}`,
              labels: labelsOf(conversation, row, journalEmpty),
            })
          : Promise.resolve(undefined),
      ]);
      for (const [index, job] of graded.entries()) {
        const result = replies[index];
        if (result !== undefined) {
          recordReplyGrade(
            t,
            ref,
            job.target.replyIndex,
            job.target.item,
            result
          );
        }
      }
      recordConversationGrade(t, ref, {
        call,
        codeFlags: row.simulatedUserFlags,
        crisisTurn,
        ended: row.ended,
        exchanges,
        lastUserText: row.turns[exchanges.at(-1)?.userIndex ?? -1]?.text ?? "",
        userRating: row.userRating,
      });
    },
    timeoutMs: conversationTimeoutMs(conversation.maxTurns),
  });
}

/**
 * One eval for each conversation in the transcripts. A conversation on the
 * empty journal is judged against the empty-journal person's fact sheet, the
 * same one its Sage had. The people are loaded once, and the fact sheet and
 * journal text are made once for each person, so every call about a person
 * starts the same way.
 */
export function conversationGradeEvals(
  deps: ConversationGradeDeps = {}
): Promise<EvalDefinition | EvalDefinition[]> {
  const env = deps.env ?? process.env;
  return guardedEvals(
    "conversation grade",
    async () => {
      const rows = uniqueRows(
        (deps.loadTranscripts ?? loadTranscripts)().filter(isConversationRow)
      );
      const settings = deps.settings ?? settingsFromEnv(env);
      const load = deps.loadPerson ?? loadPerson;
      const people = new Map<string, LoadedPerson>();
      await Promise.all(
        [...new Set(rows.map((row) => row.person))].map(async (id) => {
          people.set(id, await load(id));
        })
      );
      const host = rows.some((row) => row.journal === "empty")
        ? await loadEmptyJournalPerson(load)
        : undefined;
      const texts = new Map<string, string>();
      const contextFor = (row: TranscriptRow, owner: LoadedPerson): string => {
        const source =
          row.journal === "empty" ? (host ?? emptyJournalStandIn()) : owner;
        let text = texts.get(source.id);
        if (text === undefined) {
          text = formatJournalContext(source, { today: env[ENV_TODAY] });
          texts.set(source.id, text);
        }
        return text;
      };
      const shared: Shared = {
        contextFor,
        deps,
        manifest: manifestReader(env, { manifest: deps.manifest }),
        settings,
      };
      return rows.flatMap((row) => {
        const owner = people.get(row.person);
        return owner === undefined
          ? []
          : [conversationEval(row, owner, shared)];
      });
    },
    "No generated conversations. Run make eval so the chat pass writes them."
  );
}
