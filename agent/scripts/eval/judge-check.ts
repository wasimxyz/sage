// The judge check, from the runner's side.
//
// The check itself is an eval (`agent/evals/judge-check/`): a few labeled
// items that the judge must grade the way the labels say. The runner starts it
// before any local work, in every sweep. It runs against the stub grade
// target, with the gateway key, and with no person, no setup, and no Sage.
//
// The eval records one `hard:judge-check` check per item. This file reads
// those rows and decides whether the sweep may go on:
//
//   passed       every item matched its label
//   missed       a planted failure got through, or a clean item was flagged
//   not checked  the judge could not answer, or an item recorded nothing
//
// A miss and "not checked" both stop the sweep.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadDreamCheckItems,
  loadReplyCheckItems,
} from "../../evals/lib/judge-check.ts";
import {
  loadRecordedResults,
  type RecordedEvalResult,
} from "../../evals/lib/recorder.ts";
import {
  JUDGE_CHECK_PERSON,
  type JudgeCheckMiss,
  judgeCheckMissSchema,
  type SweepSummary,
} from "../../evals/lib/schema.ts";
import type { Env } from "./env.ts";
import { buildJudgeCheckEnv, PASS_CONCURRENCY, runEvalPass } from "./passes.ts";

/** The eve eval id of the check: a folder under `agent/evals/`. */
export const JUDGE_CHECK_EVAL = "judge-check";

const JUDGE_CHECK_LABEL = "hard:judge-check";

export interface JudgeCheckFiles {
  dir: string;
  log: string;
  results: string;
}

/** Where the check leaves its rows and its log, in the sweep's run directory. */
export function judgeCheckFiles(runDir: string): JudgeCheckFiles {
  const dir = join(runDir, "judge-check");
  return {
    dir,
    log: join(dir, "judge-check.log"),
    results: join(dir, "judge-check.results.jsonl"),
  };
}

/** How many items the check has, for the estimate. Throws a readable error when an item file is broken. */
export async function judgeCheckSize(): Promise<{
  dreamItems: number;
  replyItems: number;
}> {
  const [dream, replies] = await Promise.all([
    loadDreamCheckItems(),
    loadReplyCheckItems(),
  ]);
  return { dreamItems: dream.length, replyItems: replies.length };
}

/** True for a row the judge check recorded. Setup reports leave these out. */
export function isJudgeCheckRow(row: RecordedEvalResult): boolean {
  return row.metadata.person === JUDGE_CHECK_PERSON;
}

// ---------------------------------------------------------------------------
// Reading the rows
// ---------------------------------------------------------------------------

/** An item the check could not settle, and why. */
export interface UncheckedItem {
  itemId: string;
  reason: string;
}

export interface JudgeCheckReading {
  /** Items whose verdicts matched their labels. */
  checked: number;
  /** Planted failures the judge let through, and clean items it flagged. */
  misses: JudgeCheckMiss[];
  /** Items the judge could not grade, or that recorded no result. */
  unchecked: UncheckedItem[];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The misses the eval wrote into the check's metadata. Falls back to one general miss. */
function missesOf(
  metadata: Record<string, unknown>,
  itemId: string,
  fallback: string | undefined
): JudgeCheckMiss[] {
  const listed = Array.isArray(metadata.misses) ? metadata.misses : [];
  const misses = listed.flatMap((entry) => {
    const parsed = judgeCheckMissSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (misses.length > 0) {
    return misses;
  }
  return [
    {
      check: "judge-check",
      detail:
        fallback ??
        "The judge's verdicts do not match the labels for this item.",
      itemId,
      kind: "missed",
    },
  ];
}

/** Reads the rows of the check. Pass only the judge-check rows. */
export function readJudgeCheck(
  rows: readonly RecordedEvalResult[]
): JudgeCheckReading {
  const reading: JudgeCheckReading = { checked: 0, misses: [], unchecked: [] };
  for (const row of rows) {
    const itemId = textOf(row.metadata.itemId) ?? row.id;
    const assertion = row.assertions.find(
      (candidate) => candidate.name === JUDGE_CHECK_LABEL
    );
    if (assertion === undefined) {
      reading.unchecked.push({
        itemId,
        reason:
          row.error ?? row.skipReason ?? "The item recorded no verdict at all.",
      });
      continue;
    }
    const metadata = assertion.metadata ?? {};
    const reason = textOf(metadata.reason) ?? assertion.message;
    if (metadata.notGraded === true || assertion.errored === true) {
      reading.unchecked.push({
        itemId,
        reason: reason ?? "The judge gave no answer.",
      });
    } else if (assertion.passed === false) {
      reading.misses.push(...missesOf(metadata, itemId, reason));
    } else if (assertion.passed === true) {
      reading.checked += 1;
    } else {
      reading.unchecked.push({
        itemId,
        reason: "The check recorded no pass or fail.",
      });
    }
  }
  return reading;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface JudgeCheckResult {
  /** Items whose verdicts matched their labels. */
  checked: number;
  /** What to print: the match, or what the sweep stops on. */
  lines: string[];
  /** True when the sweep may go on. */
  ok: boolean;
  /** For the sweep summary. */
  summary: SweepSummary["judgeCheck"];
}

function describeMiss(miss: JudgeCheckMiss): string {
  return `  ${miss.kind} ${miss.check} in ${miss.itemId}: ${miss.detail}`;
}

/**
 * The sweep may go on only when at least one item matched its label and
 * nothing missed or went unchecked. `problems` are things that went wrong
 * around the check, such as a crash, and also stop the sweep.
 */
export function judgeCheckResult(
  reading: JudgeCheckReading,
  problems: readonly string[] = []
): JudgeCheckResult {
  const { checked, misses, unchecked } = reading;
  const empty = checked === 0 && misses.length === 0 && unchecked.length === 0;
  const ok = !empty && misses.length === 0 && unchecked.length === 0;
  const summary = { misses, passed: ok && problems.length === 0 };
  if (summary.passed) {
    return {
      checked,
      lines: [
        `Judge check: the judge matched the label on all ${checked} item${checked === 1 ? "" : "s"}.`,
      ],
      ok: true,
      summary,
    };
  }
  const lines: string[] = [];
  if (misses.length > 0) {
    lines.push(
      "The judge check missed, so the sweep stopped before it built or ran anything:",
      ...misses.map(describeMiss)
    );
  }
  if (unchecked.length > 0) {
    lines.push(
      "The judge could not be checked, so the sweep stopped before it built or ran anything:",
      ...unchecked.map((item) => `  ${item.itemId}: ${item.reason}`)
    );
  }
  if (empty) {
    lines.push(
      "The judge could not be checked: the judge check recorded no items, so the sweep stopped before it built or ran anything."
    );
  } else if (ok) {
    lines.push(
      "The judge check did not finish cleanly, so the sweep stopped before it built or ran anything:"
    );
  }
  lines.push(...problems);
  return { checked, lines, ok: false, summary };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface JudgeCheckRun {
  agentDir: string;
  /** The gateway key. The judge cannot run without it. */
  credentials: Record<string, string>;
  runDir: string;
  /** The stub grade target. The check never sends a message. */
  stubUrl: string;
  sweepFile: string;
  sweepId: string;
}

export interface JudgeCheckDeps {
  /** The environment the runner started with. Tests give their own. */
  base?: Env;
  /** Runs one `eve eval` pass. Tests replace it. */
  runPass?: typeof runEvalPass;
}

/**
 * Runs the check and reads its rows. The user's eve filters are not passed:
 * they pick people's evals, and the check has no person. Never throws; a check
 * that could not run comes back as a result that stops the sweep.
 */
export async function runJudgeCheck(
  run: JudgeCheckRun,
  deps: JudgeCheckDeps = {}
): Promise<JudgeCheckResult> {
  const files = judgeCheckFiles(run.runDir);
  mkdirSync(files.dir, { recursive: true });
  const outcome = await (deps.runPass ?? runEvalPass)(
    {
      agentDir: run.agentDir,
      concurrency: PASS_CONCURRENCY.grade,
      filters: [],
      prefixes: [JUDGE_CHECK_EVAL],
      url: run.stubUrl,
    },
    {
      echoPrefix: "[judge check]",
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
      `The judge check crashed (exit ${outcome.code}). The log is ${files.log}.`
    );
  }
  let rows: RecordedEvalResult[] = [];
  try {
    rows = loadRecordedResults(files.results).filter(isJudgeCheckRow);
  } catch (error) {
    problems.push(
      `The judge check's results could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return judgeCheckResult(readJudgeCheck(rows), problems);
}
