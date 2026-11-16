// Sweeps that run no Sage: `calibration` and `head-to-head`.
//
// Each is one grade pass against the stub target, with the gateway key and no
// person, no setup, and no local model. The runner builds the stub target,
// prints an estimate, asks, runs the pass, and reads the rows it recorded. The
// modules `calibration.ts` and `head-to-head.ts` say what to do with the rows.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { costUsd, type ModelPrice } from "../../evals/lib/prices.ts";
import {
  loadRecordedResults,
  type RecordedEvalResult,
} from "../../evals/lib/recorder.ts";
import type { Env } from "./env.ts";
import { ESTIMATE_TOKENS } from "./estimate.ts";
import { buildJudgeCheckEnv, PASS_CONCURRENCY, runEvalPass } from "./passes.ts";

export type StandaloneName = "calibration" | "head-to-head";

export interface StandaloneFiles {
  dir: string;
  log: string;
  results: string;
}

/** Where a standalone pass leaves its rows and its log, in the run folder. */
export function standaloneFiles(
  runDir: string,
  name: StandaloneName
): StandaloneFiles {
  const dir = join(runDir, name);
  return {
    dir,
    log: join(dir, `${name}.log`),
    results: join(dir, `${name}.results.jsonl`),
  };
}

export interface StandaloneRun {
  agentDir: string;
  /** The gateway key. The judge cannot run without it. */
  credentials: Record<string, string>;
  /** Eve filters from ARGS, such as `--tag opener`. */
  filters: readonly string[];
  name: StandaloneName;
  /** The eval ids to run, such as `calibration/agreement`. */
  prefixes: readonly string[];
  runDir: string;
  /** The stub grade target. These passes never send a message. */
  stubUrl: string;
  sweepFile: string;
  sweepId: string;
}

export interface StandaloneDeps {
  /** The environment the runner started with. Tests give their own. */
  base?: Env;
  /** Runs one `eve eval` pass. Tests replace it. */
  runPass?: typeof runEvalPass;
}

export interface StandaloneResult {
  files: StandaloneFiles;
  /** Things that went wrong around the pass, such as a crash or an unreadable file. */
  problems: string[];
  rows: RecordedEvalResult[];
}

/**
 * Runs the pass and reads its rows. The environment is the judge check's: no
 * person, no setup, no transcripts, the sweep file, and the run folder for the
 * spending ledger. A leftover results file is deleted first, so a rerun never
 * counts a row twice. Never throws; a pass that could not run comes back with
 * a problem.
 */
export async function runStandalone(
  run: StandaloneRun,
  deps: StandaloneDeps = {}
): Promise<StandaloneResult> {
  const files = standaloneFiles(run.runDir, run.name);
  mkdirSync(files.dir, { recursive: true });
  rmSync(files.results, { force: true });
  const outcome = await (deps.runPass ?? runEvalPass)(
    {
      agentDir: run.agentDir,
      concurrency: PASS_CONCURRENCY.grade,
      filters: run.filters,
      prefixes: run.prefixes,
      url: run.stubUrl,
    },
    {
      echoPrefix: `[${run.name}]`,
      env: buildJudgeCheckEnv({
        agentDir: run.agentDir,
        base: deps.base,
        credentials: run.credentials,
        results: files.results,
        runDir: run.runDir,
        sweepFile: run.sweepFile,
        sweepId: run.sweepId,
      }),
      logFile: files.log,
    }
  );
  const problems: string[] = [];
  if (outcome.status === "crashed") {
    problems.push(
      `The ${run.name} pass crashed (exit ${outcome.code}). The log is ${files.log}.`
    );
  }
  let rows: RecordedEvalResult[] = [];
  try {
    rows = loadRecordedResults(files.results);
  } catch (error) {
    problems.push(
      `The ${run.name} results could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { files, problems, rows };
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/** A reply grade and a comparison are each one judge call, about as long as a reply grade. */
export const STANDALONE_ESTIMATE = {
  /** The judge reads a fact sheet, a journal, and two replies, or two conversations. */
  headToHeadTokens: {
    cachedInputTokens: 9600,
    inputTokens: 14_000,
    outputTokens: 250,
  },
  /** About 12 seconds a call, four at a time. */
  secondsPerCall: 12,
} as const;

export interface StandaloneEstimate {
  calls: number;
  costUsd: number;
  hours: number;
  lines: string[];
}

function estimateCalls(
  calls: number,
  price: ModelPrice,
  tokens:
    | typeof ESTIMATE_TOKENS.replyJudge
    | typeof STANDALONE_ESTIMATE.headToHeadTokens,
  what: string
): StandaloneEstimate {
  const cost = calls * costUsd(price, tokens);
  const hours =
    (calls * STANDALONE_ESTIMATE.secondsPerCall) /
    PASS_CONCURRENCY.grade /
    3600;
  return {
    calls,
    costUsd: cost,
    hours,
    lines: [
      `Estimate: about ${Math.max(1, Math.round(hours * 60))} minutes and $${cost.toFixed(2)}`,
      `  ${calls} judge call${calls === 1 ? "" : "s"}: ${what}`,
    ],
  };
}

/** What the judge check costs: one call for each of its items, as the sweep's estimate counts them. */
export function estimateJudgeCheck(
  size: {
    conversationItems: number;
    dreamItems: number;
    replyItems: number;
  },
  price: ModelPrice
): number {
  return (
    size.dreamItems * costUsd(price, ESTIMATE_TOKENS.dreamSourceJudge) +
    size.replyItems * costUsd(price, ESTIMATE_TOKENS.replyJudge) +
    size.conversationItems * costUsd(price, ESTIMATE_TOKENS.conversationJudge)
  );
}

/** One reply grade for each reply you graded. */
export function estimateCalibration(
  replies: number,
  price: ModelPrice
): StandaloneEstimate {
  return estimateCalls(
    replies,
    price,
    ESTIMATE_TOKENS.replyJudge,
    `one for each of the ${replies} repl${replies === 1 ? "y" : "ies"} you graded`
  );
}

/** Two comparisons for each shared item of each pair. */
export function estimateHeadToHead(
  calls: number,
  price: ModelPrice
): StandaloneEstimate {
  return estimateCalls(
    calls,
    price,
    STANDALONE_ESTIMATE.headToHeadTokens,
    "two for each shared item of each pair, one for each order"
  );
}
