// The hours and dollars a sweep will take, before it starts.
//
// Hours come from the last report's timings for each chat model, else from
// the defaults below, plus the Dream runs the cache cannot answer. Dollars
// come from the judge's and the simulated user's token counts at the
// gateway's prices. These are rough: the point is to catch a sweep that would
// take three nights or blow the spending cap, not to predict the minute.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  parseSetupReport,
  REPORT_SUFFIX,
  type SetupReport,
  type SweepFile,
} from "../../evals/lib/schema.ts";
import { type ModelPrice, priceUsd } from "./cloud.ts";
import type { PlanGroup, RunPlan } from "./plan.ts";

/** What the estimate assumes when it has nothing better. Seconds unless noted. */
export const ESTIMATE_DEFAULTS = {
  buildMinutes: 3,
  dreamSecondsPerEntry: { off: 30, on: 60 },
  eveStartSeconds: 25,
  gradeTailMinutes: 3,
  modelLoadSeconds: 30,
  personCheckSeconds: 4,
  replySeconds: { off: 25, on: 60 },
  sageStartSeconds: 20,
} as const;

/** Tokens per cloud call. The judge's prompt is mostly a cacheable prefix. */
export const ESTIMATE_TOKENS = {
  dreamSourceJudge: { cachedShare: 0, inputTokens: 5000, outputTokens: 1000 },
  factJudge: { cachedShare: 0, inputTokens: 3000, outputTokens: 400 },
  replyJudge: { cachedShare: 0.8, inputTokens: 12_000, outputTokens: 2000 },
  simulatedUserTurn: { cachedShare: 0, inputTokens: 2000, outputTokens: 250 },
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
  /** Chat prompt overlays and Sage builds are rebuilt every run. */
  dreamMisses: ReadonlySet<string>;
  history: TimingHistory;
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

function replyCount(
  counts: RunPlan["people"][number]["counts"],
  sweep: SweepFile
): { conversationTurns: number; replies: number } {
  const wants = (test: SweepFile["tests"][number]) => sweep.tests.includes(test);
  const conversationTurns = wants("conversations")
    ? counts.conversationTurns * sweep.repeats
    : 0;
  const replies =
    (wants("facts") ? counts.chatRefs * sweep.repeats : 0) +
    (wants("openers") ? counts.openers * sweep.repeats : 0) +
    conversationTurns;
  return { conversationTurns, replies };
}

function dreamSeconds(group: PlanGroup, entries: number): number {
  return entries * ESTIMATE_DEFAULTS.dreamSecondsPerEntry[group.memory];
}

export function estimateRun(input: EstimateInput): Estimate {
  const { dreamMisses, history, plan, prices, sweep } = input;
  const defaults = ESTIMATE_DEFAULTS;
  const wants = (test: SweepFile["tests"][number]) => sweep.tests.includes(test);
  let dreamSecs = 0;
  let missCount = 0;
  let personSecs = 0;
  let chatSecs = 0;
  let judgeUsd = 0;
  let simUsd = 0;

  for (const group of plan.groups) {
    for (const person of plan.people) {
      if (!person.empty && dreamMisses.has(dreamMissKey(group.dreamKeyId, person.id))) {
        dreamSecs += dreamSeconds(group, person.counts.entries);
        missCount += 1;
      }
      if (wants("person")) {
        personSecs +=
          defaults.personCheckSeconds * person.counts.personChecks;
        const judged =
          group.memory === "on"
            ? person.counts.judgedRefs
            : person.counts.summaryRefs;
        judgeUsd += judged * priceUsd(prices.judge, ESTIMATE_TOKENS.factJudge);
      }
      if (wants("dream-accuracy")) {
        judgeUsd +=
          person.counts.entries *
          priceUsd(prices.judge, ESTIMATE_TOKENS.dreamSourceJudge);
      }
      for (const prompt of group.prompts) {
        for (const setup of prompt.setups) {
          const { conversationTurns, replies } = replyCount(person.counts, sweep);
          const perReply =
            history.get(historyKey(setup.chatModel, setup.thinking)) ??
            defaults.replySeconds[setup.thinking === "off" ? "off" : "on"];
          chatSecs += replies * perReply;
          judgeUsd +=
            replies * priceUsd(prices.judge, ESTIMATE_TOKENS.replyJudge);
          simUsd +=
            conversationTurns *
            priceUsd(prices.simulatedUser, ESTIMATE_TOKENS.simulatedUserTurn);
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
  const totalSecs = fixedSecs + dreamSecs + personSecs + chatSecs;
  const hours = totalSecs / 3600;
  const costUsd = judgeUsd + simUsd;

  const lines = [
    `Dream: ${missCount} run${missCount === 1 ? "" : "s"} the cache cannot answer, about ${(dreamSecs / 3600).toFixed(1)} h`,
    `Person checks: about ${(personSecs / 3600).toFixed(2)} h`,
    `Chat: about ${(chatSecs / 3600).toFixed(1)} h of replies`,
    `Setup: about ${(fixedSecs / 3600).toFixed(1)} h for builds, ${stats.sageStarts} Sage starts, ${stats.eveDevStarts} Chat server starts, and about ${stats.modelLoads} model loads`,
    `Cloud: about $${judgeUsd.toFixed(2)} for the judge and $${simUsd.toFixed(2)} for the simulated user`,
  ];
  return { costUsd, dreamMissCount: missCount, hours, lines };
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
