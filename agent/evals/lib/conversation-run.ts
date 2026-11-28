/**
 * One conversation, played out: the simulated user types, Sage replies, and
 * the turns go into one transcript row.
 *
 * Who writes each of the person's messages:
 *
 * - turn 1 is the conversation's `opening`, word for word
 * - the crisis turn is `crisis.message`, word for word
 * - a turn named in `script` is that entry's `message`, word for word
 * - every other turn is written by the simulated user, who sees only the
 *   visible messages and the person's card (`simulated-user.ts`)
 *
 * Every message to Sage goes through `sendTurn`, so every send carries the
 * setup's `x-sage-*` headers. The first message starts a session on the eval
 * context. Each later one goes to the session the turn before it came from.
 *
 * The conversation ends when:
 *
 * - the simulated user says `done`. Its message is the person's closing one, so
 *   it is sent first, and Sage replies to it. A `done` is ignored while a
 *   scripted turn is still ahead, because that turn is part of the test.
 * - the person has sent `maxTurns` messages (`max-turns`)
 * - a Sage turn fails (`error`), which counts against Sage
 * - the simulated user fails (`simulator-error`), which does not
 *
 * Each Sage turn records `counted:turn-works` on its own turn. After a
 * conversation that ended in `done` or `max-turns`, the simulated user rates
 * it from 1 to 5. A flag the runner can set itself goes on the row: ending
 * within a turn of the crisis, and giving no usable message after it.
 */
import { assistantTurnOf, recordTurnWorks, userTurnOf } from "./chat-turn.ts";
import { codeFlagsFor } from "./conversation-checks.ts";
import type { ItemRef, ScoreHost } from "./record.ts";
import type {
  Conversation,
  EndedReason,
  Journal,
  Setup,
  TranscriptRow,
  Turn,
} from "./schema.ts";
import { setupHeaders } from "./setup.ts";
import type { SimulatedUser, VisibleMessage } from "./simulated-user.ts";
import {
  sendTurn,
  type TimedTurn,
  type TurnSender,
  turnWorksStatus,
} from "./turn.ts";

/** The most time a conversation of up to 12 turns gets. */
export const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000;
/** The most time a longer conversation gets. */
export const LONG_CONVERSATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** A conversation with more person messages than this gets the longer time. */
export const LONG_CONVERSATION_TURNS = 12;

/** How long an eval for this conversation may run. */
export function conversationTimeoutMs(maxTurns: number): number {
  return maxTurns > LONG_CONVERSATION_TURNS
    ? LONG_CONVERSATION_TIMEOUT_MS
    : CONVERSATION_TIMEOUT_MS;
}

/** What `runConversation` needs to know about the conversation and its person. */
export interface ConversationRun {
  /** The person's `about`, for the simulated user. */
  about: string;
  conversation: Conversation;
  /** `empty` when the conversation runs on the empty journal. */
  journal: Journal;
}

type NextMessage =
  | { done: boolean; message: string; ok: true }
  | { ok: false; reason: string; unusable: boolean };

/** The turn numbers that are written in advance: the crisis, and each `script` entry. */
export function scriptedTurns(conversation: Conversation): number[] {
  return [
    ...(conversation.crisis === undefined ? [] : [conversation.crisis.turn]),
    ...Object.keys(conversation.script ?? {}).map(Number),
  ];
}

/** The text written in advance for turn `n`, if there is any. The opening is turn 1. */
export function scriptedMessage(
  conversation: Conversation,
  n: number
): string | undefined {
  if (n === 1) {
    return conversation.opening;
  }
  if (conversation.crisis?.turn === n) {
    return conversation.crisis.message;
  }
  return conversation.script?.[String(n)]?.message;
}

async function nextMessage(
  run: ConversationRun,
  simulator: SimulatedUser,
  label: string,
  n: number,
  messages: readonly VisibleMessage[]
): Promise<NextMessage> {
  const { conversation } = run;
  const written = scriptedMessage(conversation, n);
  if (written !== undefined) {
    return { done: false, message: written, ok: true };
  }
  const result = await simulator.next({
    about: run.about,
    afterCrisis:
      conversation.crisis !== undefined && n > conversation.crisis.turn,
    label,
    maxTurns: conversation.maxTurns,
    // A copy, so a simulated user that keeps it never sees later messages.
    messages: [...messages],
    persona: conversation.persona,
    turn: n,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason, unusable: result.unusable };
  }
  const scriptedAhead = scriptedTurns(conversation).some(
    (turn) => turn > n && turn <= conversation.maxTurns
  );
  return {
    done: result.value.done && !scriptedAhead,
    message: result.value.message,
    ok: true,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface State {
  ended: EndedReason;
  messages: VisibleMessage[];
  note?: string;
  turns: Turn[];
  unusable: boolean;
  /** How many messages the person has sent. */
  userTurns: number;
}

/**
 * Plays the conversation. A Sage turn that throws (a closed stream, a
 * timeout) is a failed `turn-works` check and ends the conversation as
 * `error`. A setup the headers cannot express, such as an unsupported thinking
 * level, still throws, because no turn could work.
 */
export async function runConversation(
  t: ScoreHost & TurnSender,
  item: ItemRef,
  run: ConversationRun,
  setup: Setup,
  simulator: SimulatedUser
): Promise<TranscriptRow> {
  setupHeaders(setup);
  const { conversation } = run;
  const state: State = {
    ended: "max-turns",
    messages: [],
    turns: [],
    unusable: false,
    userTurns: 0,
  };
  let target: TurnSender = t;
  for (let n = 1; n <= conversation.maxTurns; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn answers the one before it.
    const next = await nextMessage(
      run,
      simulator,
      item.itemId,
      n,
      state.messages
    );
    if (!next.ok) {
      state.ended = "simulator-error";
      state.note = `The simulated user failed on turn ${n}: ${next.reason}`;
      state.unusable = next.unusable;
      break;
    }
    state.userTurns = n;
    state.turns.push(userTurnOf(next.message));
    let sent: TimedTurn | undefined;
    let failure: string | undefined;
    try {
      sent = await sendTurn(target, next.message, setup);
    } catch (error) {
      failure = errorText(error);
    }
    recordTurnWorks(t, item, setup, sent, failure, state.turns.length);
    state.turns.push(assistantTurnOf(sent, failure));
    state.messages.push(
      { role: "user", text: next.message },
      { role: "assistant", text: sent?.turn.reply ?? "" }
    );
    if (sent === undefined || turnWorksStatus(sent.turn.status) === "failed") {
      state.ended = "error";
      break;
    }
    target = sent.turn.session;
    if (next.done) {
      state.ended = "done";
      break;
    }
  }
  return finish(item, run, simulator, state);
}

async function finish(
  item: ItemRef,
  run: ConversationRun,
  simulator: SimulatedUser,
  state: State
): Promise<TranscriptRow> {
  const { conversation } = run;
  let userRating: TranscriptRow["userRating"];
  if (state.ended === "done" || state.ended === "max-turns") {
    const rated = await simulator.rate({
      about: run.about,
      label: item.itemId,
      messages: state.messages,
      persona: conversation.persona,
    });
    if (rated.ok) {
      userRating = {
        level: rated.value.rating,
        reason: rated.value.reason,
      };
    } else {
      state.note = `The simulated user gave no rating: ${rated.reason}`;
    }
  }
  return {
    ended: state.ended,
    itemId: item.itemId,
    journal: run.journal,
    kind: "conversation",
    ...(state.note === undefined ? {} : { note: state.note }),
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
    simulatedUserFlags: codeFlagsFor({
      crisisTurn: conversation.crisis?.turn,
      ended: state.ended,
      lastUserTurn: state.userTurns,
      unusableAnswer: state.unusable,
    }),
    turns: state.turns,
    ...(userRating === undefined ? {} : { userRating }),
  };
}
