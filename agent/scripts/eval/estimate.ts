// The hours and dollars a sweep will take, before it starts.
//
// Hours come from the last report's timings for each chat model, else from
// the defaults below, plus the Dream runs the cache cannot answer. Dollars
// come from the judge's and the simulated user's token counts at the
// gateway's prices, and include the judge check that every sweep runs first. These are rough: the point is to catch a sweep that would
// take three nights or blow the spending cap, not to predict the minute.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { costUsd } from "../../evals/lib/prices.ts";
import {
  parseSetupReport,
  REPORT_SUFFIX,
  type Setup,
  type SetupReport,
  type SweepFile,
} from "../../evals/lib/schema.ts";
import type { ModelPrice } from "./cloud.ts";
import type { PlanGroup, RunPlan } from "./plan.ts";

/** What the estimate assumes when it has nothing better. Seconds unless noted. */
export const ESTIMATE_DEFAULTS = {
  buildMinutes: 3,
  // One judge call per source. A cached grade costs nothing, so a run that
  // reuses its grades takes less.
  dreamAccuracySecondsPerSource: 20,
  dreamSecondsPerEntry: { off: 30, on: 60 },
  eveStartSeconds: 25,
  gradeTailMinutes: 3,
  // About 20 seconds a call, two at a time. The check runs before any local work.
  judgeCheckSecondsPerItem: 10,
  modelLoadSeconds: 30,
  personCheckSeconds: 4,
  replySeconds: { off: 25, on: 60 },
  sageStartSeconds: 20,
  // The simulated user's call for each person message after the opening.
  simulatedUserSeconds: 5,
} as const;

/** Tokens per cloud call. The judge's prompt is mostly a cacheable prefix. */
export const ESTIMATE_TOKENS = {
  // One call for a whole conversation: the journal, then every exchange.
  conversationJudge: {
    cachedInputTokens: 9600,
    inputTokens: 16_000,
    outputTokens: 1500,
  },
  dreamSourceJudge: { inputTokens: 5000, outputTokens: 1000 },
  factJudge: { inputTokens: 3000, outputTokens: 400 },
  replyJudge: {
    cachedInputTokens: 9600,
    inputTokens: 12_000,
    outputTokens: 2000,
  },
  // The person's last call: the card and the whole conversation, then a rating.
  simulatedUserRating: { inputTokens: 3000, outputTokens: 120 },
  simulatedUserTurn: { inputTokens: 2000, outputTokens: 250 },
} as const;

export function dreamMissKey(dreamKeyId: string, person: string): string {
  return `${dreamKeyId}:${person}`;
}

/** Seconds per Chat reply, by chat model, from the newest report that has timings for it. */
export type TimingHistory = Map<string, number>;

/** The mean wait for a whole reply in a report, in seconds. Null when it has no timings. */
export function secondsPerReply(report: SetupReport): number | null {
  const totals: number[] = [];
  for (const item of report.items) {
    for (const turn of item.turns) {
      if (turn.role === "assistant" && turn.timing !== undefined) {
        totals.push(turn.timing.totalMs);
      }
    }
  }
  if (totals.length === 0) {
    return null;
  }
  return totals.reduce((sum, ms) => sum + ms, 0) / totals.length / 1000;
}

export function loadTimingHistory(reportsDir: string): TimingHistory {
  const history: TimingHistory = new Map();
  let names: string[];
  try {
    names = readdirSync(reportsDir).filter((name) =>
      name.endsWith(REPORT_SUFFIX)
    );
  } catch {
    return history;
  }
  const dated = names
    .map((name) => ({ mtime: statSync(join(reportsDir, name)).mtimeMs, name }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of dated) {
    try {
      const report = parseSetupReport(
        JSON.parse(readFileSync(join(reportsDir, name), "utf8")),
        name
      );
      const seconds = secondsPerReply(report);
      const key = historyKey(report.setup.chatModel, report.setup.thinking);
      if (seconds !== null && !history.has(key)) {
        history.set(key, seconds);
      }
    } catch {
      // An old or damaged report does not help the estimate.
    }
  }
  return history;
}

export function historyKey(chatModel: string, thinking: string): string {
  return `${chatModel}|${thinking === "off" ? "off" : "on"}`;
}

export interface EstimateInput {
  /** `dreamMissKey` of each group and person whose Dream the cache cannot answer. */
  dreamMisses: ReadonlySet<string>;
  history: TimingHistory;
  /**
   * The items of the judge check, which every sweep runs first. A Dream item
   * costs one source grade and a reply item one reply grade. Leave it out for
   * a plan that has no check.
   */
  judgeCheck?: {
    /** Whole-conversation grades. Each conversation item's graded replies count as `replyItems`. */
    conversationItems?: number;
    dreamItems: number;
    replyItems: number;
  };
  plan: RunPlan;
  prices: { judge: ModelPrice; simulatedUser: ModelPrice };
  sweep: SweepFile;
}

export interface Estimate {
  costUsd: number;
  dreamMissCount: number;
  hours: number;
  lines: string[];
}

/**
 * What one person sends in one setup. A conversation is counted at its
 * `maxTurns`, the most it can take, so the estimate runs high for the ones that
 * end sooner. Each turn has a Sage reply, graded as a reply, and a call to the
 * simulated user (the opening is written in advance, so it has none).
 */
function replyCount(
  counts: RunPlan["people"][number]["counts"],
  sweep: SweepFile
): { conversations: number; conversationTurns: number; replies: number } {
  const wants = (test: SweepFile["tests"][number]) =>
    sweep.tests.includes(test);
  const conversations = wants("conversations")
    ? counts.conversations * sweep.repeats
    : 0;
  const conversationTurns = wants("conversations")
    ? counts.conversationTurns * sweep.repeats
    : 0;
  const replies =
    (wants("facts") ? counts.chatRefs * sweep.repeats : 0) +
    (wants("openers") ? counts.openers * sweep.repeats : 0) +
    conversationTurns;
  return { conversations, conversationTurns, replies };
}

function dreamSeconds(group: PlanGroup, entries: number): number {
  return entries * ESTIMATE_DEFAULTS.dreamSecondsPerEntry[group.memory];
}

/** Running sums while the estimate walks the plan. */
interface Sums {
  chatSecs: number;
  dreamSecs: number;
  judgeUsd: number;
  missCount: number;
  personSecs: number;
  simUsd: number;
}

type Person = RunPlan["people"][number];

/** Dream, the person checks, and the judge's share of both, for one person under one snapshot. */
function addPersonPass(
  sums: Sums,
  input: EstimateInput,
  group: PlanGroup,
  person: Person
): void {
  const { dreamMisses, prices, sweep } = input;
  const wants = (test: SweepFile["tests"][number]) =>
    sweep.tests.includes(test);
  if (
    !person.empty &&
    dreamMisses.has(dreamMissKey(group.dreamKeyId, person.id))
  ) {
    sums.dreamSecs += dreamSeconds(group, person.counts.entries);
    sums.missCount += 1;
  }
  if (wants("person")) {
    sums.personSecs +=
      ESTIMATE_DEFAULTS.personCheckSeconds * person.counts.personChecks;
    const judged =
      group.memory === "on"
        ? person.counts.judgedRefs
        : person.counts.summaryRefs;
    sums.judgeUsd += judged * costUsd(prices.judge, ESTIMATE_TOKENS.factJudge);
  }
  if (wants("dream-accuracy")) {
    sums.judgeUsd +=
      person.counts.entries *
      costUsd(prices.judge, ESTIMATE_TOKENS.dreamSourceJudge);
    sums.personSecs +=
      person.counts.entries * ESTIMATE_DEFAULTS.dreamAccuracySecondsPerSource;
  }
}

/** Chat replies, the judge's grading of them, and the simulated user, for one setup. */
function addSetupChat(
  sums: Sums,
  input: EstimateInput,
  setup: Setup,
  person: Person
): void {
  const { history, prices, sweep } = input;
  const { conversations, conversationTurns, replies } = replyCount(
    person.counts,
    sweep
  );
  const perReply =
    history.get(historyKey(setup.chatModel, setup.thinking)) ??
    ESTIMATE_DEFAULTS.replySeconds[setup.thinking === "off" ? "off" : "on"];
  sums.chatSecs +=
    replies * perReply +
    (conversationTurns - conversations) *
      ESTIMATE_DEFAULTS.simulatedUserSeconds;
  sums.judgeUsd +=
    replies * costUsd(prices.judge, ESTIMATE_TOKENS.replyJudge) +
    conversations * costUsd(prices.judge, ESTIMATE_TOKENS.conversationJudge);
  sums.simUsd +=
    (conversationTurns - conversations) *
      costUsd(prices.simulatedUser, ESTIMATE_TOKENS.simulatedUserTurn) +
    conversations *
      costUsd(prices.simulatedUser, ESTIMATE_TOKENS.simulatedUserRating);
}

export function estimateRun(input: EstimateInput): Estimate {
  const { plan } = input;
  const defaults = ESTIMATE_DEFAULTS;
  const sums: Sums = {
    chatSecs: 0,
    dreamSecs: 0,
    judgeUsd: 0,
    missCount: 0,
    personSecs: 0,
    simUsd: 0,
  };
  const check = {
    conversationItems: 0,
    dreamItems: 0,
    replyItems: 0,
    ...input.judgeCheck,
  };
  const checkUsd =
    check.dreamItems *
      costUsd(input.prices.judge, ESTIMATE_TOKENS.dreamSourceJudge) +
    check.replyItems * costUsd(input.prices.judge, ESTIMATE_TOKENS.replyJudge) +
    check.conversationItems *
      costUsd(input.prices.judge, ESTIMATE_TOKENS.conversationJudge);
  const checkSecs =
    (check.dreamItems + check.replyItems + check.conversationItems) *
    defaults.judgeCheckSecondsPerItem;
  sums.judgeUsd += checkUsd;
  for (const group of plan.groups) {
    for (const person of plan.people) {
      addPersonPass(sums, input, group, person);
      for (const prompt of group.prompts) {
        for (const setup of prompt.setups) {
          addSetupChat(sums, input, setup, person);
        }
      }
    }
  }

  const { stats } = plan;
  const fixedSecs =
    plan.memoryValues.length * defaults.buildMinutes * 60 +
    stats.sageStarts * defaults.sageStartSeconds +
    stats.eveDevStarts * defaults.eveStartSeconds +
    stats.modelLoads * defaults.modelLoadSeconds +
    defaults.gradeTailMinutes * 60;
  const totalSecs =
    fixedSecs + checkSecs + sums.dreamSecs + sums.personSecs + sums.chatSecs;
  const checkItems =
    check.dreamItems + check.replyItems + check.conversationItems;
  const lines = [
    ...(checkItems === 0
      ? []
      : [
          `Judge check: ${checkItems} item${checkItems === 1 ? "" : "s"}, about ${(checkSecs / 60).toFixed(0)} min and $${checkUsd.toFixed(2)}`,
        ]),
    `Dream: ${sums.missCount} run${sums.missCount === 1 ? "" : "s"} the cache cannot answer, about ${(sums.dreamSecs / 3600).toFixed(1)} h`,
    `Person checks: about ${(sums.personSecs / 3600).toFixed(2)} h`,
    `Chat: about ${(sums.chatSecs / 3600).toFixed(1)} h of replies`,
    `Setup: about ${(fixedSecs / 3600).toFixed(1)} h for builds, ${stats.sageStarts} Sage starts, ${stats.eveDevStarts} Chat server starts, and about ${stats.modelLoads} model loads`,
    `Cloud: about $${sums.judgeUsd.toFixed(2)} for the judge and $${sums.simUsd.toFixed(2)} for the simulated user`,
  ];
  return {
    costUsd: sums.judgeUsd + sums.simUsd,
    dreamMissCount: sums.missCount,
    hours: totalSecs / 3600,
    lines,
  };
}

export function formatEstimate(
  estimate: Estimate,
  options: { capUsd: number; defaultedPrices: readonly string[] }
): string[] {
  const out = [
    `Estimate: about ${estimate.hours.toFixed(1)} hours and $${estimate.costUsd.toFixed(2)}`,
    ...estimate.lines.map((line) => `  ${line}`),
  ];
  if (options.defaultedPrices.length > 0) {
    out.push(
      `  No gateway price for ${options.defaultedPrices.join(", ")}; the estimate uses default prices.`
    );
  }
  if (estimate.costUsd > options.capUsd) {
    out.push(
      `  The estimate is over the $${options.capUsd} spending cap. Past the cap, the rest is marked "not graded".`
    );
  }
  out.push(
    "  Times come from the last report for each chat model, else from defaults. Filters passed in ARGS are not applied."
  );
  return out;
}
