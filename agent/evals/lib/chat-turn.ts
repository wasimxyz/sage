/**
 * One Chat question, sent and checked.
 *
 * `chat/facts.eval.ts` runs this for each `chat` question in a person's
 * `case.yaml`. It sends the question with the setup's headers, records the
 * checks, and returns the transcript row for the grade pass to read.
 */
import type { EveEvalToolCall } from "eve/evals";

import { type ItemRef, recordCheck, type ScoreHost } from "./record.ts";
import type { Setup, TranscriptRow } from "./schema.ts";
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

function recordTurnWorks(
  t: ScoreHost,
  item: ItemRef,
  setup: Setup,
  sent: TimedTurn | undefined,
  failure: string | undefined
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

function transcriptRow(
  item: ItemRef,
  chat: ChatQuestion,
  sent: TimedTurn | undefined,
  failure: string | undefined
): TranscriptRow {
  const failed = sent === undefined || sent.turn.status === "failed";
  return {
    ended: failed ? "error" : "done",
    itemId: item.itemId,
    journal: "own",
    kind: "chat",
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
    simulatedUserFlags: [],
    turns: [
      { role: "user", stepModelIds: [], text: chat.question, toolCalls: [] },
      {
        ...(failure === undefined ? {} : { error: failure }),
        role: "assistant",
        stepModelIds: sent?.stepModelIds ?? [],
        text: sent?.turn.message ?? "",
        ...(sent === undefined ? {} : { timing: sent.timing }),
        toolCalls: toTranscriptToolCalls(sent?.turn.toolCalls ?? []),
      },
    ],
  };
}

/**
 * Sends one question and records `counted:turn-works`, plus the soft search
 * checks the question asks for. A turn that throws (a closed stream, a
 * timeout) is a failed "turn works" check and a transcript row with
 * `ended: "error"`, not a crash. A setup the headers cannot express, such as
 * an unsupported thinking level, still throws, because no turn could work.
 */
export async function runChatQuestion(
  t: ScoreHost & TurnSender,
  item: ItemRef,
  chat: ChatQuestion,
  setup: Setup
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
  return transcriptRow(item, chat, sent, failure);
}
