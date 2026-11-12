/**
 * Grading every Chat reply.
 *
 * `grade/replies.eval.ts` makes one eval for each reply in the transcripts: the
 * openers and the fact questions. Each reply gets one structured judge call.
 * The judge sees the rubric and the check definitions, the person's fact sheet
 * and full journal, the item's labels, the message, what Sage did, and the
 * reply. Which checks apply to the reply is decided in code (`checks.ts`).
 *
 * What is recorded, all on the assistant turn of the item:
 *
 * - hard: `crisis-handled` (only `expect: crisis`) and `no-severe-unsupported`
 * - counted: `journal-right` (with the journal errors in its metadata),
 *   `no-overreach`, `no-harmful-agreement`, `no-brushing-off`,
 *   `asks-before-exercise`, and `ignores-injected` (items tagged `injection`)
 * - rubric, scored 1 to 5 and stored as 0 to 1: understanding, warmth,
 *   questions-help, focus, right-help, journal-use, fits-moment, and
 *   weighs-events. A rubric item that does not apply is recorded as N/A.
 *
 * A fact question's reference answer goes to the judge too. A reply that
 * contradicts it, or leaves out what it must state, fails `journal-right`.
 * That replaces the separate `chat-factuality` score.
 *
 * A call the judge could not make records every check as "not graded". It
 * never records a failure.
 *
 * Everything that touches the world (the people, the transcripts, the judge)
 * is passed in, so the tests run with made-up people and a mock judge.
 */
import { defineEval } from "eve/evals";

import { checksFor, type ReplyItem, type RubricAsk } from "./checks.ts";
import { type LoadedPerson, loadPerson } from "./dataset.ts";
import { type Grader, replyCall, sharedGrader } from "./grader.ts";
import { formatJournalContext } from "./judge-context.ts";
import { EMPTY_JOURNAL_PERSON, openerTags, splitOpenerKey } from "./openers.ts";
import {
  type EvalDefinition,
  failEval,
  guardedEvals,
  tagsFor,
} from "./pass.ts";
import {
  type CheckRecord,
  type ItemRef,
  itemMetadata,
  makeItem,
  recordCheck,
  type ScoreHost,
} from "./record.ts";
import type { ReplyGradeInput } from "./rubric.ts";
import {
  ENV_TODAY,
  type JournalError,
  type Opener,
  parseItemId,
  type ReplyGrade,
  rubricLevelToScore,
  type ToolCall,
  type TranscriptRow,
} from "./schema.ts";
import { loadTranscripts } from "./transcripts.ts";

export const NO_REPLY_REASON = "Generation did not produce a reply to grade.";

// ---------------------------------------------------------------------------
// From a transcript row to what the judge sees
// ---------------------------------------------------------------------------

/** Everything the judge is shown about one reply, apart from the journal. */
export interface ReplyTarget {
  item: ReplyItem;
  message: string;
  reply: string;
  /** The index in the row's `turns` of the reply. Checks are recorded on it. */
  replyIndex: number;
  toolCalls: ToolCall[];
}

/** True for the rows this module grades. */
export function isReplyRow(row: TranscriptRow): boolean {
  return row.kind === "opener" || row.kind === "chat";
}

function lastAssistantIndex(row: TranscriptRow): number {
  for (let index = row.turns.length - 1; index >= 0; index -= 1) {
    if (row.turns[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

type Owner = Pick<LoadedPerson, "empty" | "id" | "personCase">;

/** The opener a row is about, from the person who wrote it. Throws when it is not there. */
function openerOfRow(row: TranscriptRow, owner: Owner): Opener {
  const parsed = parseItemId(row.itemId);
  if (parsed === null) {
    throw new Error(`${row.itemId} is not an item id.`);
  }
  const { openerId } = splitOpenerKey(parsed.key);
  const opener = owner.personCase.openers.find(
    (candidate) => candidate.id === openerId
  );
  if (opener === undefined) {
    throw new Error(`${owner.id} has no opener "${openerId}".`);
  }
  return opener;
}

/** The labels for a row's item, from the person who wrote it. Throws when the item is not there. */
export function itemOfRow(row: TranscriptRow, owner: Owner): ReplyItem {
  const parsed = parseItemId(row.itemId);
  if (parsed === null) {
    throw new Error(`${row.itemId} is not an item id.`);
  }
  const journalEmpty = row.journal === "empty" || owner.empty;
  if (row.kind === "opener") {
    const opener = openerOfRow(row, owner);
    return {
      avoid: opener.avoid,
      expect: opener.expect,
      fits: opener.fits,
      journalEmpty,
      kind: "opener",
      search: opener.search,
      style: opener.style,
      tags: opener.tags,
      thought: opener.thought,
    };
  }
  const chat = owner.personCase.chat[Number(parsed.key) - 1];
  if (chat === undefined) {
    throw new Error(`${owner.id} has no chat question for ${row.itemId}.`);
  }
  return {
    avoid: [],
    expect: "question",
    fits: [],
    journalEmpty,
    kind: "chat",
    reference: chat.reference,
    search: chat.search ?? (chat.expectTool ? "needed" : undefined),
    tags: [],
  };
}

/** The message, the reply, and the labels of a row. */
export function targetOfRow(row: TranscriptRow, owner: Owner): ReplyTarget {
  const replyIndex = lastAssistantIndex(row);
  const reply = replyIndex === -1 ? undefined : row.turns[replyIndex];
  const message = row.turns.find((turn) => turn.role === "user")?.text ?? "";
  return {
    item: itemOfRow(row, owner),
    message,
    reply: reply?.text ?? "",
    replyIndex,
    toolCalls: reply?.toolCalls ?? [],
  };
}

// ---------------------------------------------------------------------------
// Asking the judge
// ---------------------------------------------------------------------------

export type ReplyGradeResult =
  | {
      callId: string;
      costUsd: number;
      grade: ReplyGrade;
      model: string;
      ok: true;
      rubric: string;
    }
  | { model: string; ok: false; reason: string; rubric: string };

/** Asks the judge to grade one reply. Never throws. */
export async function gradeReply(
  grader: Grader,
  input: ReplyGradeInput
): Promise<ReplyGradeResult> {
  const outcome = await grader.judge(replyCall(input));
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

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function describeErrors(errors: readonly JournalError[]): string {
  return errors
    .map((error) => `[${error.kind}] "${error.evidence}": ${error.reason}`)
    .join(" ");
}

function notGradedReason(id: string): string {
  return `not graded: the judge gave no verdict for ${id}`;
}

/** What the recording functions share: the judge's answer, and how to write one check. */
interface Recording {
  grade: ReplyGrade | undefined;
  /** Records a check the judge gave no verdict for. */
  missing: (checkId: string, tier: CheckRecord["tier"]) => void;
  record: (check: CheckRecord) => void;
}

function recordHard(recording: Recording, ids: readonly string[]): void {
  for (const checkId of ids) {
    const verdict = recording.grade?.hard.find((entry) => entry.id === checkId);
    if (verdict === undefined || verdict.pass === null) {
      recording.missing(checkId, "hard");
    } else {
      recording.record({
        checkId,
        evidence: verdict.evidence,
        pass: verdict.pass,
        reason: verdict.reason,
        tier: "hard",
      });
    }
  }
}

function countedRecord(
  checkId: string,
  grade: ReplyGrade | undefined
): CheckRecord | null {
  const verdict = grade?.counted.find((entry) => entry.id === checkId);
  const errors =
    checkId === "journal-right" ? (grade?.journalErrors ?? []) : [];
  if (verdict === undefined && errors.length === 0) {
    return null;
  }
  if (verdict?.pass === null && errors.length === 0) {
    return {
      checkId,
      notApplicable: true,
      reason: verdict.reason,
      tier: "counted",
    };
  }
  const failed = verdict?.pass === false || errors.length > 0;
  return {
    checkId,
    evidence: errors[0]?.evidence ?? verdict?.evidence,
    journalErrors: errors,
    pass: !failed,
    reason: errors.length > 0 ? describeErrors(errors) : verdict?.reason,
    tier: "counted",
  };
}

function recordCounted(recording: Recording, ids: readonly string[]): void {
  for (const checkId of ids) {
    const check = countedRecord(checkId, recording.grade);
    if (check === null) {
      recording.missing(checkId, "counted");
    } else {
      recording.record(check);
    }
  }
}

function rubricRecord(
  ask: RubricAsk,
  grade: ReplyGrade | undefined,
  unavailable: string | undefined
): CheckRecord {
  const extra =
    ask.id === "right-help" ? { helpSeen: grade?.helpSeen ?? [] } : undefined;
  const base = { checkId: ask.id, extra, tier: "rubric" } as const;
  if (ask.notApplicable !== null) {
    return {
      ...base,
      notApplicable: true,
      reason: `N/A: ${ask.notApplicable}`,
    };
  }
  const score = grade?.rubric.find((entry) => entry.id === ask.id);
  if (score === undefined) {
    return {
      ...base,
      notGraded: true,
      reason: unavailable ?? notGradedReason(ask.id),
    };
  }
  if (score.level === null) {
    return { ...base, notApplicable: true, reason: `N/A: ${score.reason}` };
  }
  return {
    ...base,
    evidence: score.evidence,
    extra: { ...extra, level: score.level },
    reason: score.reason,
    score: rubricLevelToScore(score.level),
  };
}

/**
 * Records the checks that apply to a reply, from the judge's answer.
 *
 * - A hard or counted check passes or fails on the judge's `pass`.
 *   `journal-right` also fails when the judge lists a journal error.
 * - A hard check with no verdict is not graded. A counted check the judge
 *   answers with `null` does not apply, and one it leaves out is not graded.
 * - A rubric item is scored from the judge's level. Level `null` is N/A. An
 *   item the labels make N/A is recorded as N/A whatever the judge says.
 * - A judge that could not answer leaves every check not graded.
 */
export function recordReplyGrade(
  t: ScoreHost,
  ref: ItemRef,
  turnIndex: number,
  item: ReplyItem,
  result: ReplyGradeResult
): void {
  const applied = checksFor(item);
  const judged = result.ok
    ? {
        judgeCallId: result.callId,
        judgeCostUsd: result.costUsd,
        judgeModel: result.model,
        rubric: result.rubric,
      }
    : { judgeModel: result.model, rubric: result.rubric };
  const unavailable = result.ok ? undefined : result.reason;
  const record = (check: CheckRecord): void => {
    recordCheck(t, ref, {
      ...check,
      extra: { ...judged, ...check.extra },
      turnIndex,
    });
  };
  const recording: Recording = {
    grade: result.ok ? result.grade : undefined,
    missing: (checkId, tier) =>
      record({
        checkId,
        notGraded: true,
        reason: unavailable ?? notGradedReason(checkId),
        tier,
      }),
    record,
  };
  recordHard(recording, applied.hard);
  recordCounted(recording, applied.counted);
  for (const ask of applied.rubric) {
    record(rubricRecord(ask, recording.grade, unavailable));
  }
}

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

export interface ReplyEvalDeps {
  env?: Env;
  grader?: Grader;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
  /** Reads the generated transcripts. Defaults to `SAGE_EVAL_TRANSCRIPTS`. */
  loadTranscripts?: () => TranscriptRow[];
}

/** One row for each item and repeat. If a row repeats, the last one wins. */
export function uniqueRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const byKey = new Map<string, TranscriptRow>();
  for (const row of rows) {
    byKey.set(`${row.itemId}\u0000${row.repeat}`, row);
  }
  return [...byKey.values()];
}

/** A person with nothing in the journal, for an empty-journal run when the real one cannot be loaded. */
export function emptyJournalStandIn(): LoadedPerson {
  return {
    dir: "",
    empty: true,
    entries: [],
    id: EMPTY_JOURNAL_PERSON,
    personCase: {
      about:
        "A first-time user. The journal is empty and there are no past chats.",
      cast: [],
      chat: [],
      conversations: [],
      events: [],
      facts: [],
      id: EMPTY_JOURNAL_PERSON,
      openers: [],
      retrieval: [],
      summaries: [],
      tags: [],
      timeline: [],
    },
  };
}

/**
 * The person whose Sage has the empty journal, for the judge's fact sheet.
 * It falls back to a bare stand-in, because an empty journal has nothing else
 * to say.
 */
export async function loadEmptyJournalPerson(
  load: (id: string) => Promise<LoadedPerson> = loadPerson
): Promise<LoadedPerson> {
  try {
    return await load(EMPTY_JOURNAL_PERSON);
  } catch {
    return emptyJournalStandIn();
  }
}

function replyEval(
  row: TranscriptRow,
  owner: LoadedPerson,
  contextFor: (row: TranscriptRow, owner: LoadedPerson) => Promise<string>,
  deps: ReplyEvalDeps
): EvalDefinition {
  let target: ReplyTarget;
  try {
    target = targetOfRow(row, owner);
  } catch (error) {
    return failEval(`${row.itemId} (judge)`, error);
  }
  const ref = makeItem(
    {
      itemId: row.itemId,
      kind: row.kind === "opener" ? "opener" : "chat",
      person: row.person,
    },
    row.setupId,
    row.repeat
  );
  const tags =
    row.kind === "opener"
      ? openerTags({
          journal: row.journal,
          opener: openerOfRow(row, owner),
          owner,
        })
      : tagsFor(owner, "chat");
  return defineEval({
    description: `${row.itemId}: reply grade (judge)${row.repeat > 1 ? ` (repeat ${row.repeat})` : ""}`,
    metadata: itemMetadata(ref),
    tags,
    async test(t) {
      if (
        row.ended === "error" ||
        target.replyIndex === -1 ||
        target.reply.trim() === ""
      ) {
        t.skip(NO_REPLY_REASON);
        return;
      }
      const result = await gradeReply(deps.grader ?? sharedGrader(), {
        context: await contextFor(row, owner),
        item: target.item,
        label: `reply ${row.itemId}`,
        message: target.message,
        reply: target.reply,
        toolCalls: target.toolCalls,
      });
      recordReplyGrade(t, ref, target.replyIndex, target.item, result);
    },
  });
}

/**
 * One eval for each reply in the transcripts. A reply on the empty journal is
 * judged against the empty-journal person's fact sheet, the same one its Sage
 * had. The people are loaded once, and the fact sheet and journal text are
 * made once for each person, so every call about a person starts the same way.
 */
export function replyEvals(
  deps: ReplyEvalDeps = {}
): Promise<EvalDefinition | EvalDefinition[]> {
  const env = deps.env ?? process.env;
  return guardedEvals(
    "reply grade",
    async () => {
      const rows = uniqueRows(
        (deps.loadTranscripts ?? loadTranscripts)().filter(isReplyRow)
      );
      const load = deps.loadPerson ?? loadPerson;
      const people = new Map<string, LoadedPerson>();
      const ids = new Set(rows.map((row) => row.person));
      await Promise.all(
        [...ids].map(async (id) => {
          people.set(id, await load(id));
        })
      );
      const host = rows.some((row) => row.journal === "empty")
        ? await loadEmptyJournalPerson(load)
        : undefined;
      const texts = new Map<string, string>();
      const contextFor = (
        row: TranscriptRow,
        owner: LoadedPerson
      ): Promise<string> => {
        const source =
          row.journal === "empty" ? (host ?? emptyJournalStandIn()) : owner;
        let text = texts.get(source.id);
        if (text === undefined) {
          text = formatJournalContext(source, { today: env[ENV_TODAY] });
          texts.set(source.id, text);
        }
        return Promise.resolve(text);
      };
      return rows.flatMap((row) => {
        const owner = people.get(row.person);
        return owner === undefined
          ? []
          : [replyEval(row, owner, contextFor, deps)];
      });
    },
    "No generated Chat transcripts. Run make eval so the chat pass writes them."
  );
}
