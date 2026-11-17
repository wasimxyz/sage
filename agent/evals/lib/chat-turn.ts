/**
 * One Chat message, sent and checked.
 *
 * `chat/facts.eval.ts` runs this for each `chat` question in a person's
 * `case.yaml`, and `chat/openers.eval.ts` runs it for each opener. It sends the
 * message with the setup's headers, records the checks, and returns the
 * transcript row for the grade pass to read.
 */
import type { EveEvalToolCall } from "eve/evals";

import { type ItemRef, recordCheck, type ScoreHost } from "./record.ts";
import type {
  Journal,
  Setup,
  TranscriptKind,
  TranscriptRow,
  Turn,
} from "./schema.ts";
import { memoryOn, setupHeaders } from "./setup.ts";
import {
  checkTurnWorks,
  sendTurn,
  type TimedTurn,
  type TurnSender,
  toTranscriptToolCalls,
} from "./turn.ts";

export interface ChatQuestion {
  /** The answer should come from a journal or memory search. */
  expectTool: boolean;
  /** The answer should come from a search that passed `when`. */
  expectWhen: boolean;
  question: string;
}

/** What the transcript row says about the message. A fact question is `chat` on the person's own journal. */
export interface RowKind {
  journal: Journal;
  kind: TranscriptKind;
}

const CHAT_ROW: RowKind = { journal: "own", kind: "chat" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completed(calls: readonly EveEvalToolCall[]): EveEvalToolCall[] {
  return calls.filter((call) => call.status === "completed");
}

function searchedJournalOrMemories(
  calls: readonly EveEvalToolCall[],
  memory: boolean
): boolean {
  // With memory off the agent has no memory tool, so it cannot count.
  return completed(calls).some(
    (call) =>
      call.name === "search_journal" ||
      (memory && call.name === "facts__search_memories")
  );
}

function passedWhen(calls: readonly EveEvalToolCall[]): boolean {
  return completed(calls).some(
    (call) =>
      call.name === "search_journal" &&
      typeof call.input.when === "string" &&
      call.input.when.trim().length > 0
  );
}

/**
 * Records `counted:turn-works` for one turn. In a conversation, `turnIndex` is
 * the index of Sage's turn in the transcript row, which puts the check on that
 * turn in the report.
 */
export function recordTurnWorks(
  t: ScoreHost,
  item: ItemRef,
  setup: Setup,
  sent: TimedTurn | undefined,
  failure: string | undefined,
  turnIndex?: number
): void {
  const works = checkTurnWorks({
    chatModel: setup.chatModel,
    parkedOnInput: (sent?.turn.inputRequests.length ?? 0) > 0,
    replyText: sent?.turn.message ?? "",
    status: sent?.turn.status ?? "failed",
    stepModelIds: sent?.stepModelIds ?? [],
  });
  const problems =
    failure === undefined
      ? works.problems
      : [`the turn did not finish: ${failure}`];
  recordCheck(t, item, {
    checkId: "turn-works",
    extra: {
      stepModelIds: sent?.stepModelIds ?? [],
      ...(sent === undefined ? {} : { timing: sent.timing }),
    },
    pass: problems.length === 0,
    reason: problems.length === 0 ? undefined : problems.join("; "),
    tier: "counted",
    turnIndex,
  });
}

function recordSearchChecks(
  t: ScoreHost,
  item: ItemRef,
  chat: ChatQuestion,
  setup: Setup,
  turn: TimedTurn["turn"]
): void {
  if (chat.expectTool) {
    recordCheck(t, item, {
      checkId: "searched-journal-or-memories",
      pass: searchedJournalOrMemories(turn.toolCalls, memoryOn(setup)),
      tier: "soft",
    });
  }
  if (chat.expectWhen) {
    recordCheck(t, item, {
      checkId: "passed-when-to-search-journal",
      pass: passedWhen(turn.toolCalls),
      tier: "soft",
    });
  }
}

/** The person's turn of a transcript row. */
export function userTurnOf(text: string): Turn {
  return { role: "user", stepModelIds: [], text, toolCalls: [] };
}

/** Sage's turn of a transcript row: its text, tool calls, and timing, or the error that stopped it. */
export function assistantTurnOf(
  sent: TimedTurn | undefined,
  failure: string | undefined
): Turn {
  return {
    ...(failure === undefined ? {} : { error: failure }),
    role: "assistant",
    stepModelIds: sent?.stepModelIds ?? [],
    text: sent?.turn.message ?? "",
    ...(sent === undefined ? {} : { timing: sent.timing }),
    toolCalls: toTranscriptToolCalls(sent?.turn.toolCalls ?? []),
  };
}

function transcriptRow(
  item: ItemRef,
  chat: ChatQuestion,
  sent: TimedTurn | undefined,
  failure: string | undefined,
  row: RowKind
): TranscriptRow {
  const failed = sent === undefined || sent.turn.status === "failed";
  return {
    ended: failed ? "error" : "done",
    itemId: item.itemId,
    journal: row.journal,
    kind: row.kind,
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
    simulatedUserFlags: [],
    turns: [userTurnOf(chat.question), assistantTurnOf(sent, failure)],
  };
}

/**
 * Sends one message and records `counted:turn-works`, plus the soft search
 * checks the message asks for. A turn that throws (a closed stream, a
 * timeout) is a failed "turn works" check and a transcript row with
 * `ended: "error"`, not a crash. A setup the headers cannot express, such as
 * an unsupported thinking level, still throws, because no turn could work.
 */
export async function runChatQuestion(
  t: ScoreHost & TurnSender,
  item: ItemRef,
  chat: ChatQuestion,
  setup: Setup,
  row: RowKind = CHAT_ROW
): Promise<TranscriptRow> {
  setupHeaders(setup);
  let sent: TimedTurn | undefined;
  let failure: string | undefined;
  try {
    sent = await sendTurn(t, chat.question, setup);
  } catch (error) {
    failure = errorText(error);
  }
  recordTurnWorks(t, item, setup, sent, failure);
  if (sent !== undefined) {
    recordSearchChecks(t, item, chat, setup, sent.turn);
  }
  return transcriptRow(item, chat, sent, failure, row);
}

/**
 * Sends an opener: one message from the person, one reply from Sage. It records
 * `counted:turn-works` and writes a transcript row of kind `opener`. `journal`
 * is `empty` when the opener runs against the empty journal. The opener's
 * search expectation is graded by a later change, so no search check is
 * recorded here.
 */
export function runOpener(
  t: ScoreHost & TurnSender,
  item: ItemRef,
  opener: { message: string },
  setup: Setup,
  journal: Journal = "own"
): Promise<TranscriptRow> {
  return runChatQuestion(
    t,
    item,
    { expectTool: false, expectWhen: false, question: opener.message },
    setup,
    { journal, kind: "opener" }
  );
}
