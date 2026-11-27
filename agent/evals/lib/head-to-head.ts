/**
 * Head-to-head judging.
 *
 * Scores rank every setup of a sweep. For the final pick, the judge compares
 * the best few directly: it sees two replies (or two whole conversations) to
 * the same message, and picks one or calls a tie.
 *
 * - The setups are the top 2 or 3 of a finished sweep by `rankSetups`, among
 *   those that passed every hard check. Every pair of them is compared.
 * - A pair is compared on each item both setups answered: an opener, a fact
 *   question, or a conversation, with the same repeat number. An item is left
 *   out when either side's turn failed, or the simulated user failed or went
 *   soft after a crisis, because the two sides are then not comparable.
 * - The judge sees every item twice, once with each setup first, so the
 *   position of a reply cannot decide a result. A setup wins an item only when
 *   it wins in both orders. Any other result is a tie, and an item whose
 *   orders disagree is also counted as a split.
 *
 * `grade/head-to-head.eval.ts` makes one eval for each pair and item and
 * records `soft:head-to-head` with the result in its metadata. The runner
 * folds the rows into the `headToHead` field of the compared sweep's summary
 * (`scripts/eval/head-to-head.ts`).
 *
 * Everything that touches the world (the people, the sweep's files, the
 * judge) is passed in, so the tests run with made-up people and a mock judge.
 */
import { defineEval } from "eve/evals";

import { exchangesOf } from "./conversation-checks.ts";
import { conversationOfRow } from "./conversation-grade.ts";
import type { ConversationExchange } from "./conversation-rubric.ts";
import { type LoadedPerson, loadPerson } from "./dataset.ts";
import { type Grader, headToHeadCall, sharedGrader } from "./grader.ts";
import {
  HEAD_TO_HEAD_LABELS,
  type HeadToHeadInput,
} from "./head-to-head-rubric.ts";
import { formatJournalContext } from "./judge-context.ts";
import { type EvalDefinition, guardedEvals } from "./pass.ts";
import { itemMetadata, makeItem, recordCheck } from "./record.ts";
import { itemOfRow, loadEmptyJournalPerson } from "./reply-grade.ts";
import { detailLines } from "./rubric.ts";
import {
  HEAD_TO_HEAD_MAX_SETUPS,
  HEAD_TO_HEAD_MIN_SETUPS,
  type HeadToHeadItem,
  type HeadToHeadOrder,
  type HeadToHeadPair,
  type HeadToHeadStanding,
  type HeadToHeadSummary,
  type HeadToHeadWinner,
  rankSetups,
  readPassEnv,
  type SweepSummary,
  type TranscriptKind,
  type TranscriptRow,
} from "./schema.ts";
import { readPassSweep } from "./setup.ts";
import {
  defaultSweepDirs,
  loadSweepSource,
  REPLY_ITEM_KINDS,
  type SweepDirs,
  type SweepSource,
  sourceRow,
} from "./sweep-source.ts";

export const HEAD_TO_HEAD_CHECK_ID = "head-to-head";

// ---------------------------------------------------------------------------
// Choosing the setups
// ---------------------------------------------------------------------------

export interface TopSetups {
  /** Why the sweep cannot be compared. Empty when it can. */
  problems: string[];
  /** The compared setups, best first. */
  setups: string[];
}

/**
 * The first `top` setups of the sweep's ranking that passed every hard check.
 * A setup that failed one is out of the running, however its scores read.
 * Fewer than two is a problem, because there is no one to compare.
 */
export function topSetups(summary: SweepSummary, top: number): TopSetups {
  const count = Math.min(
    Math.max(top, HEAD_TO_HEAD_MIN_SETUPS),
    HEAD_TO_HEAD_MAX_SETUPS
  );
  const ranked = rankSetups(summary.ranking);
  const passed = ranked.filter((entry) => entry.passedHard);
  const setups = passed.slice(0, count).map((entry) => entry.setupId);
  if (setups.length >= HEAD_TO_HEAD_MIN_SETUPS) {
    return { problems: [], setups };
  }
  return {
    problems: [
      `Sweep ${summary.sweepId} has ${passed.length} setup${passed.length === 1 ? "" : "s"} that passed every hard check, and head-to-head needs at least ${HEAD_TO_HEAD_MIN_SETUPS}. ${ranked.length - passed.length} failed a hard check.`,
    ],
    setups,
  };
}

/** Every pair of setups, in rank order: (1st, 2nd), (1st, 3rd), (2nd, 3rd). */
export function pairsOf(setups: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [index, a] of setups.entries()) {
    for (const b of setups.slice(index + 1)) {
      pairs.push([a, b]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Choosing the items
// ---------------------------------------------------------------------------

/** One item that two setups both answered. */
export interface PairedItem {
  a: TranscriptRow;
  b: TranscriptRow;
  itemId: string;
  kind: TranscriptKind;
  person: string;
  repeat: number;
}

/** True when the row has a reply to compare, and nothing went wrong that makes it unfair to compare. */
export function comparable(row: TranscriptRow): boolean {
  if (
    row.ended === "error" ||
    row.ended === "simulator-error" ||
    row.simulatedUserFlags.length > 0
  ) {
    return false;
  }
  return exchangesOf(row.turns).some(
    (exchange) =>
      exchange.assistantIndex !== -1 &&
      (row.turns[exchange.assistantIndex]?.text.trim().length ?? 0) > 0
  );
}

function rowsOf(
  source: SweepSource,
  setupId: string
): Map<string, TranscriptRow> {
  const rows = new Map<string, TranscriptRow>();
  const report = source.reports.find((entry) => entry.setupId === setupId);
  for (const item of report?.items ?? []) {
    if (
      item.status !== "graded" ||
      !(REPLY_ITEM_KINDS as readonly string[]).includes(item.kind)
    ) {
      continue;
    }
    const row = sourceRow(source, setupId, item);
    if (row !== null && comparable(row)) {
      rows.set(`${item.itemId}\u0000${item.repeat}`, row);
    }
  }
  return rows;
}

/** The items both setups answered, in the order the first setup's report has them. */
export function sharedItems(
  source: SweepSource,
  a: string,
  b: string
): PairedItem[] {
  const first = rowsOf(source, a);
  const second = rowsOf(source, b);
  const shared: PairedItem[] = [];
  for (const [key, rowA] of first) {
    const rowB = second.get(key);
    if (rowB !== undefined) {
      shared.push({
        a: rowA,
        b: rowB,
        itemId: rowA.itemId,
        kind: rowA.kind,
        person: rowA.person,
        repeat: rowA.repeat,
      });
    }
  }
  return shared;
}

export interface PlannedPair {
  a: string;
  b: string;
  items: PairedItem[];
}

export interface HeadToHeadPlan {
  pairs: PlannedPair[];
  setups: string[];
}

/** What will be compared: the top setups, and each pair's shared items. Throws a readable error when there is nothing to compare. */
export function planHeadToHead(
  source: SweepSource,
  top: number
): HeadToHeadPlan {
  const selection = topSetups(source.summary, top);
  if (selection.problems.length > 0) {
    throw new Error(selection.problems.join(" "));
  }
  const missing = selection.setups.filter(
    (id) => !source.reports.some((report) => report.setupId === id)
  );
  if (missing.length > 0) {
    throw new Error(
      `The report of setup ${missing.join(", ")} is not in the reports folder, so it cannot be compared.`
    );
  }
  const pairs = pairsOf(selection.setups).map(([a, b]) => ({
    a,
    b,
    items: sharedItems(source, a, b),
  }));
  if (pairs.every((pair) => pair.items.length === 0)) {
    throw new Error(
      `The top setups of ${source.summary.sweepId} share no item with a reply on both sides, so there is nothing to compare.`
    );
  }
  return { pairs, setups: selection.setups };
}

/** The judge calls the plan makes: two for each item of each pair. */
export function callCount(plan: HeadToHeadPlan): number {
  return plan.pairs.reduce((sum, pair) => sum + pair.items.length * 2, 0);
}

// ---------------------------------------------------------------------------
// What the judge sees
// ---------------------------------------------------------------------------

/** The turns of a row as exchanges: a person message, Sage's tool calls, and its reply. */
export function exchangesOfRow(row: TranscriptRow): ConversationExchange[] {
  return exchangesOf(row.turns).map((exchange) => {
    const reply =
      exchange.assistantIndex === -1
        ? undefined
        : row.turns[exchange.assistantIndex];
    return {
      sage: reply?.text ?? "",
      toolCalls: reply?.toolCalls ?? [],
      user: row.turns[exchange.userIndex]?.text ?? "",
    };
  });
}

type Owner = Pick<LoadedPerson, "empty" | "id" | "personCase">;

/** The labels of an item, one line each, the same for both sides. */
export function detailsOf(row: TranscriptRow, owner: Owner): string[] {
  const journalEmpty = row.journal === "empty" || owner.empty;
  if (row.kind === "conversation") {
    const conversation = conversationOfRow(row, owner);
    const { persona } = conversation;
    const lines = [
      `- Kind of conversation (expect): ${conversation.expect}`,
      `- What the person wants: ${persona.wants}`,
      `- Their way of talking: ${persona.style}`,
      `- How open they are: ${persona.openness}`,
      `- When Sage offers an exercise, they: ${persona.onExerciseOffer}`,
      `- They keep coming back to the same worry: ${persona.ruminates ? "yes" : "no"}`,
    ];
    if (persona.keyThought !== undefined) {
      lines.push(
        `- The thought underneath: ${persona.keyThought} (information for you, not a target)`
      );
    }
    lines.push(
      `- Kinds of help that fit: ${conversation.fits.length === 0 ? "none listed" : conversation.fits.join(", ")}`,
      `- Kinds of help to avoid: ${conversation.avoid.length === 0 ? "none listed" : conversation.avoid.join(", ")}`,
      journalEmpty
        ? "- The journal is empty. There are no entries and no past chats."
        : "- The journal is the one given above."
    );
    if (conversation.crisis !== undefined) {
      lines.push(HEAD_TO_HEAD_LABELS.crisisTurn(conversation.crisis.turn));
    }
    lines.push(HEAD_TO_HEAD_LABELS.simulatedPerson);
    return lines;
  }
  const item = itemOfRow(row, owner);
  const lines = detailLines(item);
  if (item.reference !== undefined) {
    lines.push(HEAD_TO_HEAD_LABELS.referenceAnswer(item.reference));
  }
  return lines;
}

/** The journal text the judge reads for a row: its owner's, or the empty journal's. */
export function contextOf(
  row: TranscriptRow,
  owner: LoadedPerson,
  host: LoadedPerson,
  today: string | undefined
): string {
  const source = row.journal === "empty" ? host : owner;
  return formatJournalContext(source, { today });
}

/** Which side is shown first. */
export type Order = "ab" | "ba";

/** The call for one order of one item. `a` is the better-ranked setup of the pair. */
export function inputFor(
  paired: PairedItem,
  order: Order,
  parts: { context: string; details: readonly string[]; pair: string }
): HeadToHeadInput {
  const [first, second] =
    order === "ab" ? [paired.a, paired.b] : [paired.b, paired.a];
  return {
    context: parts.context,
    details: parts.details,
    first: exchangesOfRow(first),
    label: `head-to-head ${parts.pair} ${paired.itemId} r${paired.repeat} ${order}`,
    mode: paired.kind === "conversation" ? "conversation" : "reply",
    second: exchangesOfRow(second),
  };
}

// ---------------------------------------------------------------------------
// The two orders
// ---------------------------------------------------------------------------

/** The judge's answer in the places the replies were shown, turned into the pair's setups. */
export function winnerBySetup(
  position: HeadToHeadWinner,
  order: Order
): HeadToHeadWinner {
  if (position === "tie") {
    return "tie";
  }
  const firstShown = order === "ab" ? "a" : "b";
  const secondShown = order === "ab" ? "b" : "a";
  return position === "a" ? firstShown : secondShown;
}

/**
 * Settles an item from its two orders. A setup wins only when both orders pick
 * it. Anything else is a tie: both orders calling a tie, or the orders
 * disagreeing. A disagreement, including one order picking a setup and the
 * other a tie, is also a split.
 */
export function settleOrders(orders: readonly HeadToHeadOrder[]): {
  split: boolean;
  winner: HeadToHeadWinner;
} {
  const [first, second] = orders;
  if (first === undefined || second === undefined) {
    return { split: false, winner: "tie" };
  }
  if (first.winner === second.winner) {
    return { split: false, winner: first.winner };
  }
  return { split: true, winner: "tie" };
}

export type OrderOutcome =
  | { notGraded: string; ok: false }
  | { callId: string; costUsd: number; ok: true; order: HeadToHeadOrder };

async function judgeOrder(
  grader: Grader,
  paired: PairedItem,
  order: Order,
  parts: { context: string; details: readonly string[]; pair: string }
): Promise<OrderOutcome> {
  const outcome = await grader.judge(
    headToHeadCall(inputFor(paired, order, parts))
  );
  if (!outcome.ok) {
    return { notGraded: outcome.reason, ok: false };
  }
  return {
    callId: outcome.callId,
    costUsd: outcome.costUsd,
    ok: true,
    order: {
      first: order === "ab" ? "a" : "b",
      reason: outcome.value.reason,
      winner: winnerBySetup(outcome.value.winner, order),
    },
  };
}

export type ItemOutcome =
  | { notGraded: string; ok: false }
  | {
      callIds: string[];
      costUsd: number;
      item: HeadToHeadItem;
      ok: true;
      /** The rubric hash of the judge that compared them. */
      rubric: string;
    };

/**
 * Asks the judge about one item in both orders. If either call fails, the item
 * is not graded, and a single order is never used alone.
 */
export async function judgePaired(
  grader: Grader,
  paired: PairedItem,
  parts: { context: string; details: readonly string[]; pair: string }
): Promise<ItemOutcome> {
  const [forward, backward] = await Promise.all([
    judgeOrder(grader, paired, "ab", parts),
    judgeOrder(grader, paired, "ba", parts),
  ]);
  if (!(forward.ok && backward.ok)) {
    const failed = [forward, backward].find((outcome) => !outcome.ok);
    return {
      notGraded:
        failed !== undefined && !failed.ok
          ? failed.notGraded
          : "not graded: the judge gave no answer",
      ok: false,
    };
  }
  const orders = [forward.order, backward.order];
  const settled = settleOrders(orders);
  return {
    callIds: [forward.callId, backward.callId],
    costUsd: forward.costUsd + backward.costUsd,
    item: {
      itemId: paired.itemId,
      kind: paired.kind,
      orders,
      person: paired.person,
      repeat: paired.repeat,
      split: settled.split,
      winner: settled.winner,
    },
    ok: true,
    rubric: grader.rubric,
  };
}

// ---------------------------------------------------------------------------
// Tallying
// ---------------------------------------------------------------------------

/** One item of one pair, graded or not. */
export interface PairResult {
  a: string;
  b: string;
  /** Null when the item was not graded. */
  item: HeadToHeadItem | null;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/** Wins, ties, and rates for one pair. Win rates are over the graded items. */
export function tallyPair(
  a: string,
  b: string,
  results: readonly PairResult[]
): HeadToHeadPair {
  const mine = results.filter((result) => result.a === a && result.b === b);
  const items = mine.flatMap((result) =>
    result.item === null ? [] : [result.item]
  );
  const aWins = items.filter((item) => item.winner === "a").length;
  const bWins = items.filter((item) => item.winner === "b").length;
  const ties = items.filter((item) => item.winner === "tie").length;
  return {
    a,
    aWinRate: rate(aWins, items.length),
    aWins,
    b,
    bWinRate: rate(bWins, items.length),
    bWins,
    graded: items.length,
    items,
    notGraded: mine.length - items.length,
    splits: items.filter((item) => item.split).length,
    tieRate: rate(ties, items.length),
    ties,
  };
}

/** Each setup's record across its pairs, most wins first. A tie in wins goes to the higher win rate, then the better-ranked setup. */
export function standingsOf(
  setups: readonly string[],
  pairs: readonly HeadToHeadPair[]
): HeadToHeadStanding[] {
  const standings = setups.map((setupId) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const pair of pairs) {
      if (pair.a === setupId) {
        wins += pair.aWins;
        losses += pair.bWins;
        ties += pair.ties;
      } else if (pair.b === setupId) {
        wins += pair.bWins;
        losses += pair.aWins;
        ties += pair.ties;
      }
    }
    const graded = wins + losses + ties;
    return { graded, losses, setupId, ties, winRate: rate(wins, graded), wins };
  });
  return standings
    .map((standing, index) => ({ index, standing }))
    .sort(
      (x, y) =>
        y.standing.wins - x.standing.wins ||
        y.standing.winRate - x.standing.winRate ||
        x.index - y.index
    )
    .map(({ standing }) => standing);
}

export interface SummaryInput {
  costUsd: number;
  generatedAt: string;
  judge: { model: string };
  results: readonly PairResult[];
  rubric?: string;
  setups: readonly string[];
  /** The id of the run that compared them. */
  sweepId: string;
}

/** The `headToHead` field of the compared sweep's summary. */
export function buildHeadToHeadSummary(input: SummaryInput): HeadToHeadSummary {
  const pairs = pairsOf(input.setups).map(([a, b]) =>
    tallyPair(a, b, input.results)
  );
  return {
    costUsd: input.costUsd,
    generatedAt: input.generatedAt,
    judge: input.judge,
    pairs,
    ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
    setups: [...input.setups],
    standings: standingsOf(input.setups, pairs),
    sweepId: input.sweepId,
  };
}

/** The result as lines for the end of a run. */
export function describeHeadToHead(summary: HeadToHeadSummary): string[] {
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  const lines = [
    `Head to head with ${summary.judge.model}, both orders for each item:`,
  ];
  for (const pair of summary.pairs) {
    lines.push(
      `  ${pair.a} vs ${pair.b}: ${pair.aWins} to ${pair.bWins}, ${pair.ties} tied (${percent(pair.aWinRate)} / ${percent(pair.bWinRate)} / ${percent(pair.tieRate)} of ${pair.graded}), ${pair.splits} split by order, ${pair.notGraded} not graded`
    );
  }
  for (const [index, standing] of summary.standings.entries()) {
    lines.push(
      `  ${index + 1}. ${standing.setupId}: ${standing.wins} wins, ${standing.losses} losses, ${standing.ties} ties (${percent(standing.winRate)})`
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

export interface HeadToHeadEvalDeps {
  /** Where the compared sweep's reports and run folder are. Defaults to the repo's. */
  dirs?: SweepDirs;
  env?: Env;
  grader?: Grader;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
}

/**
 * One eval for each item of each pair, when the sweep file lists `head-to-head`
 * and names a sweep to compare (`compare`). Any other pass gets a skipped
 * placeholder, because eve imports every eval file for every pass.
 */
export function headToHeadEvals(
  deps: HeadToHeadEvalDeps = {}
): Promise<EvalDefinition | EvalDefinition[]> {
  const env = deps.env ?? process.env;
  return guardedEvals(
    "head-to-head",
    async () => {
      const sweep = readPassSweep(env);
      if (
        !sweep.tests.includes("head-to-head") ||
        sweep.compare === undefined
      ) {
        return [];
      }
      const source = loadSweepSource(
        sweep.compare,
        deps.dirs ?? defaultSweepDirs()
      );
      const plan = planHeadToHead(source, sweep.compareTop);
      const load = deps.loadPerson ?? loadPerson;
      const ids = new Set(
        plan.pairs.flatMap((pair) => pair.items.map((item) => item.person))
      );
      const people = new Map<string, LoadedPerson>();
      await Promise.all(
        [...ids].map(async (id) => {
          people.set(id, await load(id));
        })
      );
      const needsHost = plan.pairs.some((pair) =>
        pair.items.some((item) => item.a.journal === "empty")
      );
      const host = needsHost ? await loadEmptyJournalPerson(load) : undefined;
      const { today } = readPassEnv(env);
      return plan.pairs.flatMap((pair) =>
        pair.items.flatMap((paired) => {
          const owner = people.get(paired.person);
          return owner === undefined
            ? []
            : [
                headToHeadEval(pair, paired, {
                  context: contextOf(paired.a, owner, host ?? owner, today),
                  deps,
                  details: detailsOf(paired.a, owner),
                }),
              ];
        })
      );
    },
    "No head-to-head to run. Use make eval SWEEP=head-to-head ARGS='--compare <sweep id>'."
  );
}

function headToHeadEval(
  pair: PlannedPair,
  paired: PairedItem,
  shared: {
    context: string;
    deps: HeadToHeadEvalDeps;
    details: readonly string[];
  }
): EvalDefinition {
  const ref = makeItem(
    { itemId: paired.itemId, kind: paired.kind, person: paired.person },
    pair.a,
    paired.repeat
  );
  const pairName = `${pair.a}-${pair.b}`;
  return defineEval({
    description: `${pair.a} vs ${pair.b}: ${paired.itemId}${paired.repeat > 1 ? ` (repeat ${paired.repeat})` : ""} (judge)`,
    metadata: { ...itemMetadata(ref), pair: pairName },
    tags: ["head-to-head", paired.kind],
    async test(t) {
      const outcome = await judgePaired(
        shared.deps.grader ?? sharedGrader(),
        paired,
        { context: shared.context, details: shared.details, pair: pairName }
      );
      const base = { a: pair.a, b: pair.b, pair: pairName };
      if (!outcome.ok) {
        recordCheck(t, ref, {
          checkId: HEAD_TO_HEAD_CHECK_ID,
          extra: base,
          notGraded: true,
          reason: outcome.notGraded,
          tier: "soft",
        });
        return;
      }
      const { item } = outcome;
      recordCheck(t, ref, {
        checkId: HEAD_TO_HEAD_CHECK_ID,
        extra: {
          ...base,
          callIds: outcome.callIds,
          judgeCostUsd: outcome.costUsd,
          result: item,
          rubric: outcome.rubric,
        },
        reason: item.orders.map((order) => order.reason).join(" / "),
        score: scoreOf(item.winner),
        tier: "soft",
      });
    },
  });
}

/** `a` wins 1, a tie 0.5, `b` wins 0. */
export function scoreOf(winner: HeadToHeadWinner): number {
  if (winner === "a") {
    return 1;
  }
  return winner === "tie" ? 0.5 : 0;
}
