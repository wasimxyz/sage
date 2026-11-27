/**
 * How eval files write their results, so the runner can read them.
 *
 * - The eval's `metadata` is `{ itemId, person, setupId, kind, repeat }`.
 * - Every check is one `t.score` labeled `<tier>:<checkId>`, with metadata
 *   `{ checkId, tier, itemId, person, setupId, repeat, ... }`.
 * - Hard checks gate: one miss fails the eve eval. Counted checks are soft
 *   with a bar of 1, so a miss marks the eval `scored` and never fails it.
 *   Everything else (rubric items, slips, search metrics, plain scores) is
 *   soft with no bar.
 * - A check the judge could not grade is recorded with `notGraded: true`. It
 *   never gates and never carries a bar, because a judge error is not a
 *   failure.
 *
 * Eval files call these helpers and nothing else to record a result.
 */
import type { EveEvalContext } from "eve/evals";

import type { Graded } from "./grader.ts";
import type { CheckTier, JournalError, ReportItemKind } from "./schema.ts";

/** The check tiers, plus `soft` for scores that have no tier of their own. */
export type ResultTier = CheckTier | "soft";

/** What `t.score` needs from eve's context. */
export type ScoreHost = Pick<EveEvalContext, "score">;

export interface ItemRef {
  /** `person/<kind>/<n-or-id>`. */
  itemId: string;
  kind: ReportItemKind;
  person: string;
  /** 1-based. */
  repeat: number;
  setupId: string;
}

/** The kinds of item the person pass reads from `case.yaml`. */
export type PersonItemKind = "event" | "fact" | "retrieval" | "summary";

/**
 * `person/fact/2`: the same shape as `itemIdFor` makes for Chat items, for the
 * items the person pass checks. `n` is the 1-based position in `case.yaml`.
 */
export function personItemId(
  person: string,
  kind: PersonItemKind,
  n: number
): string {
  return `${person}/${kind}/${n}`;
}

/** The metadata every eval carries. */
export function itemMetadata(item: ItemRef): Record<string, unknown> {
  return {
    itemId: item.itemId,
    kind: item.kind,
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
  };
}

export function makeItem(
  fields: Omit<ItemRef, "repeat" | "setupId">,
  setupId: string,
  repeat = 1
): ItemRef {
  return { ...fields, repeat, setupId };
}

export interface CheckRecord {
  checkId: string;
  evidence?: string;
  /** Free-form extra metadata, such as the rank of a search hit. */
  extra?: Record<string, unknown>;
  journalErrors?: readonly JournalError[];
  /** Set when the judge could not grade this check. */
  notGraded?: boolean;
  /** Pass or fail. Gives a score of 1 or 0 unless `score` is set. */
  pass?: boolean;
  reason?: string;
  /** 0 to 1. Defaults to 1 for a pass and 0 for a fail. */
  score?: number;
  tier: ResultTier;
  /** The 0-based turn of a conversation this check is about. */
  turnIndex?: number;
}

export function checkLabel(tier: ResultTier, checkId: string): string {
  return `${tier}:${checkId}`;
}

function scoreOf(check: CheckRecord): number {
  if (check.notGraded === true) {
    return 0;
  }
  const raw = check.score ?? (check.pass === true ? 1 : 0);
  return Math.min(Math.max(raw, 0), 1);
}

function metadataOf(
  item: ItemRef,
  check: CheckRecord
): Record<string, unknown> {
  return {
    ...check.extra,
    checkId: check.checkId,
    itemId: item.itemId,
    person: item.person,
    repeat: item.repeat,
    setupId: item.setupId,
    tier: check.tier,
    ...(check.turnIndex === undefined ? {} : { turnIndex: check.turnIndex }),
    ...(check.reason === undefined ? {} : { reason: check.reason }),
    ...(check.evidence === undefined ? {} : { evidence: check.evidence }),
    ...(check.notGraded === true ? { notGraded: true } : {}),
    ...(check.journalErrors === undefined || check.journalErrors.length === 0
      ? {}
      : { journalErrors: check.journalErrors }),
  };
}

/** Records one check the way the runner reads it. */
export function recordCheck(
  t: ScoreHost,
  item: ItemRef,
  check: CheckRecord
): void {
  const handle = t
    .score({
      message: check.reason,
      metadata: metadataOf(item, check),
      score: scoreOf(check),
    })
    .label(checkLabel(check.tier, check.checkId));
  if (check.notGraded === true) {
    handle.soft();
  } else if (check.tier === "hard") {
    handle.gate(1);
  } else if (check.tier === "counted") {
    handle.soft(1);
  } else {
    handle.soft();
  }
}

/** Where a judge verdict goes: which check, and which turn. */
export interface GradeTarget {
  checkId: string;
  extra?: Record<string, unknown>;
  tier: ResultTier;
  turnIndex?: number;
}

/**
 * Records a verdict from `grader.ts`. A pass scores 1 and a fail 0. A call the
 * judge could not make is recorded as not graded, with the reason.
 */
export function recordGraded(
  t: ScoreHost,
  item: ItemRef,
  target: GradeTarget,
  graded: Graded
): void {
  recordCheck(t, item, {
    checkId: target.checkId,
    evidence: graded.evidence,
    extra: {
      ...target.extra,
      judgeModel: graded.model,
      rubric: graded.rubric,
      ...(graded.callId === undefined ? {} : { judgeCallId: graded.callId }),
      ...(graded.costUsd === undefined ? {} : { judgeCostUsd: graded.costUsd }),
    },
    notGraded: graded.notGraded,
    pass: graded.pass === true,
    reason: graded.reason,
    tier: target.tier,
    turnIndex: target.turnIndex,
  });
}
