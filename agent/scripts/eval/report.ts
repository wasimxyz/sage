// Reports.
//
// The passes leave two kinds of files behind: recorder rows (one per finished
// eve eval, with its assertions) and transcript rows (one per item and repeat,
// with the turns). This module turns them into one `SetupReport` per setup,
// computes the summary the ranking uses, and writes
// `<sweepId>__<setupId>.report.json` and `<sweepId>.sweep.json`.
//
// Row conventions (see the results convention in the shared brief):
//   eval metadata    { itemId, person, setupId, kind, repeat }
//   assertion name   "<tier>:<checkId>", tier hard|counted|rubric|slip|search|soft
//   assertion meta   { checkId, tier, turnIndex?, reason?, evidence?,
//                      notGraded?, notApplicable?, journalErrors?, helpSeen? }
// `turnIndex` counts into the transcript row's `turns`, from 0.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  RecordedAssertion,
  RecordedEvalResult,
} from "../../evals/lib/recorder.ts";
import {
  CHECK_TIERS,
  type CheckId,
  type CheckOutcome,
  type CheckTier,
  dreamSourceSchema,
  HARD_CHECK_IDS,
  type HardCheckId,
  type ItemStatus,
  journalErrorSchema,
  KINDS_OF_HELP,
  type KindOfHelp,
  loopMarkSchema,
  parseItemId,
  parseSetupReport,
  parseSweepSummary,
  type RankingEntry,
  REPORT_ITEM_KINDS,
  REPORT_SCHEMA_VERSION,
  type ReportCheck,
  type ReportItem,
  type ReportItemKind,
  type ReportRubric,
  type ReportTurn,
  rankingEntryFor,
  rankSetups,
  reportFileName,
  type Setup,
  type SetupReport,
  type SetupSummary,
  type SweepFile,
  type SweepSummary,
  setupId as setupIdOf,
  simulatedUserFlagMarkSchema,
  sweepSummaryFileName,
  type TranscriptRow,
} from "../../evals/lib/schema.ts";
import { toolUseOf } from "../../evals/lib/search-checks.ts";
import { isJudgeCheckRow } from "./judge-check.ts";
import type { PassName } from "./plan.ts";

export interface PassRow {
  pass: PassName;
  row: RecordedEvalResult;
}

export interface SwapReading {
  modelSizeMB: number | null;
  swapBaselineMB: number | null;
  swapGrowthMB: number | null;
}

export interface AssembleInput {
  gitCommit: string;
  /** Persons the setup covered, even those with no rows. */
  people: readonly string[];
  /**
   * The share of the person pass's judge cost this setup reports. The pass runs
   * once per Dream snapshot, so the setups that share it split the cost.
   */
  personShare?: number;
  promptShas: SetupReport["promptShas"];
  rows: readonly PassRow[];
  setup: Setup;
  swap?: SwapReading;
  sweep: SweepFile;
  sweepId: string;
  transcripts: readonly TranscriptRow[];
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

type Meta = Record<string, unknown> | undefined;

function text(meta: Meta, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function whole(meta: Meta, key: string): number | undefined {
  const value = meta?.[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function flag(meta: Meta, key: string): boolean {
  return meta?.[key] === true;
}

function amount(meta: Meta, key: string): number | undefined {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * What one judge call cost, and which call it was. One call can back several
 * checks, and each of them carries the same pair, so callers count a call id
 * once.
 */
function judgeCallOf(
  assertion: RecordedAssertion
): { callId: string; costUsd: number } | null {
  const callId = text(assertion.metadata, "judgeCallId");
  const costUsd = amount(assertion.metadata, "judgeCostUsd");
  return callId === undefined || costUsd === undefined
    ? null
    : { callId, costUsd };
}

/**
 * The judge's spending across rows, counting each call once. The person pass's
 * calls are scaled by `personShare`.
 */
export function judgeCostOf(rows: readonly PassRow[], personShare = 1): number {
  const seen = new Set<string>();
  let total = 0;
  for (const { pass, row } of rows) {
    for (const assertion of row.assertions) {
      const call = judgeCallOf(assertion);
      if (call !== null && !seen.has(call.callId)) {
        seen.add(call.callId);
        total += call.costUsd * (pass === "person" ? personShare : 1);
      }
    }
  }
  return total;
}

const notGradedPrefix = "not graded";

/** The soft score Dream accuracy records to carry a source and what Dream wrote from it. */
const DREAM_SOURCE_SCORE = "dream-source";

/** Eval-level skips that mean "the judge did not grade this", not "does not apply". */
export function isNotGradedSkip(reason: string | undefined): boolean {
  return reason?.toLowerCase().startsWith(notGradedPrefix) === true;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export interface ParsedAssertion {
  checkId: CheckId;
  tier: CheckTier;
}

/** `hard:crisis-handled` becomes `{ tier: "hard", checkId: "crisis-handled" }`. Null for anything else. */
export function parseAssertion(
  assertion: RecordedAssertion
): ParsedAssertion | null {
  const metaId = text(assertion.metadata, "checkId");
  const metaTier = text(assertion.metadata, "tier");
  const [labelTier, ...rest] = assertion.name.split(":");
  const tier = metaTier ?? labelTier;
  const checkId = metaId ?? rest.join(":");
  if (tier === undefined || checkId.length === 0) {
    return null;
  }
  const known = CHECK_TIERS[checkId as CheckId];
  if (known === undefined || known !== tier) {
    return null;
  }
  return { checkId: checkId as CheckId, tier: known };
}

export function checkOutcome(assertion: RecordedAssertion): CheckOutcome {
  if (flag(assertion.metadata, "notApplicable")) {
    return "skipped";
  }
  if (flag(assertion.metadata, "notGraded") || assertion.errored === true) {
    return "not-graded";
  }
  if (assertion.passed === true) {
    return "pass";
  }
  if (assertion.passed === false) {
    return "fail";
  }
  // No rule applied. A bare score of 1 is a pass.
  if (typeof assertion.score === "number") {
    return assertion.score >= 1 ? "pass" : "fail";
  }
  return "not-graded";
}

function toReportCheck(
  parsed: ParsedAssertion,
  assertion: RecordedAssertion,
  outcome: CheckOutcome
): ReportCheck {
  return {
    evidence: text(assertion.metadata, "evidence") ?? "",
    id: parsed.checkId as ReportCheck["id"],
    outcome,
    reason: text(assertion.metadata, "reason") ?? assertion.message ?? "",
  };
}

/** A 0 to 1 score back to the 1 to 5 level the judge gave. */
export function levelFromScore(score: number): 1 | 2 | 3 | 4 | 5 {
  const level = Math.min(5, Math.max(1, Math.round(score * 4) + 1));
  return level as 1 | 2 | 3 | 4 | 5;
}

function toReportRubric(
  parsed: ParsedAssertion,
  assertion: RecordedAssertion,
  outcome: CheckOutcome
): ReportRubric | null {
  if (outcome === "not-graded") {
    return null;
  }
  const scored =
    outcome !== "skipped" &&
    typeof assertion.score === "number" &&
    Number.isFinite(assertion.score);
  const score = scored ? Math.min(1, Math.max(0, assertion.score ?? 0)) : null;
  return {
    evidence: text(assertion.metadata, "evidence") ?? "",
    id: parsed.checkId as ReportRubric["id"],
    level: score === null ? null : levelFromScore(score),
    reason: text(assertion.metadata, "reason") ?? assertion.message ?? "",
    score,
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function itemKeyOf(itemId: string, repeat: number): string {
  return `${itemId}\u0000${repeat}`;
}

interface ItemRef {
  itemId: string;
  kind: ReportItemKind;
  person: string;
  repeat: number;
}

function inferKind(
  meta: Meta,
  itemId: string,
  transcript: TranscriptRow | undefined
): ReportItemKind {
  const declared = text(meta, "kind");
  const found = REPORT_ITEM_KINDS.find((kind) => kind === declared);
  if (found !== undefined) {
    return found;
  }
  if (transcript !== undefined) {
    return transcript.kind;
  }
  // Item ids read `<person>/<kind>/<key>`. The person pass uses fact, event,
  // summary, and retrieval, which `parseItemId` does not know.
  const [, segment] = itemId.split("/");
  return (
    parseItemId(itemId)?.kind ??
    REPORT_ITEM_KINDS.find((kind) => kind === segment) ??
    "fact"
  );
}

function refOf(
  row: RecordedEvalResult,
  transcripts: ReadonlyMap<string, TranscriptRow>
): ItemRef {
  const itemId = text(row.metadata, "itemId") ?? row.id;
  const repeat = whole(row.metadata, "repeat") ?? 1;
  const transcript = transcripts.get(itemKeyOf(itemId, repeat));
  const person =
    text(row.metadata, "person") ??
    transcript?.person ??
    parseItemId(itemId)?.person ??
    itemId.split("/")[0] ??
    "unknown";
  return {
    itemId,
    kind: inferKind(row.metadata, itemId, transcript),
    person,
    repeat,
  };
}

function emptyTurn(turn: TranscriptRow["turns"][number]): ReportTurn {
  return {
    ...turn,
    checks: [],
    helpSeen: [],
    journalErrors: [],
    rubric: [],
  };
}

function validList<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === null ? [] : [parsed];
  });
}

function journalErrorsOf(meta: Meta): ReportTurn["journalErrors"] {
  return validList(meta?.journalErrors, (item) => {
    const result = journalErrorSchema.safeParse(item);
    return result.success ? result.data : null;
  });
}

function helpSeenOf(meta: Meta): KindOfHelp[] {
  return validList(
    meta?.helpSeen,
    (item) => KINDS_OF_HELP.find((kind) => kind === item) ?? null
  );
}

interface ItemBuild {
  /** Judge calls already added to the item's cost. */
  callIds: Set<string>;
  /** Rows that came from a grade pass, for the "grade never ran" case. */
  gradeRows: number;
  item: ReportItem;
  notGraded: boolean;
  /** The share of a person-pass call's cost this item carries. */
  personShare: number;
  rowsSkipped: number;
  rowsTotal: number;
  softNotes: string[];
}

function newItem(
  ref: ItemRef,
  transcript: TranscriptRow | undefined,
  personShare: number
): ItemBuild {
  const item: ReportItem = {
    checks: [],
    costUsd: 0,
    ended: transcript?.ended,
    itemId: ref.itemId,
    journal: transcript?.journal ?? "own",
    kind: ref.kind,
    loopMarks: [],
    person: ref.person,
    repeat: ref.repeat,
    rubric: [],
    simulatedUserFlags: [],
    status: "graded",
    turns: transcript === undefined ? [] : transcript.turns.map(emptyTurn),
  };
  return {
    callIds: new Set(),
    gradeRows: 0,
    item,
    notGraded: false,
    personShare,
    rowsSkipped: 0,
    rowsTotal: 0,
    softNotes: [],
  };
}

/**
 * Soft scores that are not in the schema's check lists (fact-factuality,
 * summary-quality, current-outranks-stale, ...) go in the item's note. A score
 * the judge could not give still marks the item not graded.
 */
function addSoftScore(build: ItemBuild, assertion: RecordedAssertion): void {
  const id =
    text(assertion.metadata, "checkId") ??
    assertion.name.slice(assertion.name.indexOf(":") + 1);
  if (id === DREAM_SOURCE_SCORE && assertion.name.includes(":")) {
    // It carries the source and what Dream wrote for the viewer. It is no
    // score, so it adds no note. What it carries is kept even when the judge
    // did not grade the source, because Dream still wrote it.
    const dream = dreamSourceSchema.safeParse(assertion.metadata?.dream);
    if (dream.success) {
      build.item.dream = dream.data;
    }
    if (flag(assertion.metadata, "notGraded") || assertion.errored === true) {
      build.notGraded = true;
    }
    return;
  }
  if (flag(assertion.metadata, "notGraded") || assertion.errored === true) {
    build.notGraded = true;
    return;
  }
  if (assertion.name.length === 0 || !assertion.name.includes(":")) {
    // eve's own assertions, such as "succeeded", carry no label.
    return;
  }
  if (typeof assertion.score === "number") {
    build.softNotes.push(`${id} ${assertion.score.toFixed(2)}`);
  } else if (assertion.passed !== undefined) {
    build.softNotes.push(`${id} ${assertion.passed ? "pass" : "fail"}`);
  }
}

function addAssertion(
  build: ItemBuild,
  assertion: RecordedAssertion,
  pass: PassName
): void {
  const call = judgeCallOf(assertion);
  if (call !== null && !build.callIds.has(call.callId)) {
    build.callIds.add(call.callId);
    // The same scaling as the summary: setups that share a Dream snapshot split
    // the person pass's cost, so the items add up to the summary's cost.
    build.item.costUsd +=
      call.costUsd * (pass === "person" ? build.personShare : 1);
  }
  const parsed = parseAssertion(assertion);
  if (parsed === null) {
    addSoftScore(build, assertion);
    return;
  }
  const outcome = checkOutcome(assertion);
  const turnIndex = whole(assertion.metadata, "turnIndex");
  const turn =
    turnIndex === undefined ? undefined : build.item.turns[turnIndex];
  if (outcome === "not-graded") {
    build.notGraded = true;
  }
  if (parsed.tier === "rubric") {
    const rubric = toReportRubric(parsed, assertion, outcome);
    if (rubric !== null) {
      (turn?.rubric ?? build.item.rubric).push(rubric);
    }
  } else {
    (turn?.checks ?? build.item.checks).push(
      toReportCheck(parsed, assertion, outcome)
    );
  }
  if (turn !== undefined) {
    turn.journalErrors.push(...journalErrorsOf(assertion.metadata));
    for (const kind of helpSeenOf(assertion.metadata)) {
      if (!turn.helpSeen.includes(kind)) {
        turn.helpSeen.push(kind);
      }
    }
  }
  build.item.loopMarks.push(
    ...validList(assertion.metadata?.loopMarks, (mark) => {
      const result = loopMarkSchema.safeParse(mark);
      return result.success ? result.data : null;
    })
  );
  build.item.simulatedUserFlags.push(
    ...validList(assertion.metadata?.simulatedUserFlags, (mark) => {
      const result = simulatedUserFlagMarkSchema.safeParse(mark);
      return result.success ? result.data : null;
    })
  );
}

function addRow(build: ItemBuild, entry: PassRow): void {
  const { pass, row } = entry;
  build.rowsTotal += 1;
  if (pass === "grade") {
    build.gradeRows += 1;
  }
  if (row.verdict === "skipped") {
    if (isNotGradedSkip(row.skipReason)) {
      build.notGraded = true;
    } else {
      build.rowsSkipped += 1;
    }
    if (row.skipReason !== undefined) {
      build.item.note = [build.item.note, row.skipReason]
        .filter((part) => part !== undefined)
        .join(" ");
    }
    return;
  }
  for (const assertion of row.assertions) {
    addAssertion(build, assertion, pass);
  }
  if (row.error !== undefined) {
    build.item.note = [build.item.note, row.error]
      .filter((part) => part !== undefined)
      .join(" ");
    if (pass === "chat") {
      // The turn did not finish, which is a failed "Turn works".
      const recorded = build.item.checks.some(
        (check) => check.id === "turn-works"
      );
      if (!recorded) {
        build.item.checks.push({
          evidence: "",
          id: "turn-works",
          outcome: "fail",
          reason: row.error,
        });
      }
    } else {
      build.notGraded = true;
    }
  }
}

function hasGradedOutcome(item: ReportItem): boolean {
  const outcomes = [
    ...item.checks,
    ...item.turns.flatMap((turn) => turn.checks),
  ].map((check) => check.outcome);
  return (
    outcomes.some((outcome) => outcome === "pass" || outcome === "fail") ||
    [...item.rubric, ...item.turns.flatMap((turn) => turn.rubric)].some(
      (rubric) => rubric.score !== null
    )
  );
}

function settleStatus(build: ItemBuild, hasTranscript: boolean): ItemStatus {
  const { item } = build;
  if (build.rowsTotal > 0 && build.rowsSkipped === build.rowsTotal) {
    return "skipped";
  }
  if (build.notGraded) {
    return "not-graded";
  }
  const generated = hasTranscript && item.kind !== "dream-source";
  if (generated && build.gradeRows === 0) {
    return "not-graded";
  }
  return hasGradedOutcome(item) || build.rowsTotal > 0 ? "graded" : "skipped";
}

export function buildItems(
  rows: readonly PassRow[],
  transcripts: readonly TranscriptRow[],
  personShare = 1
): ReportItem[] {
  const byKey = new Map<string, TranscriptRow>();
  for (const transcript of transcripts) {
    byKey.set(itemKeyOf(transcript.itemId, transcript.repeat), transcript);
  }
  const builds = new Map<string, ItemBuild>();
  for (const entry of rows) {
    const ref = refOf(entry.row, byKey);
    const key = itemKeyOf(ref.itemId, ref.repeat);
    let build = builds.get(key);
    if (build === undefined) {
      build = newItem(ref, byKey.get(key), personShare);
      builds.set(key, build);
    }
    addRow(build, entry);
  }
  // A transcript with no rows at all was generated but never recorded.
  for (const [key, transcript] of byKey) {
    if (!builds.has(key)) {
      const ref: ItemRef = {
        itemId: transcript.itemId,
        kind: transcript.kind,
        person: transcript.person,
        repeat: transcript.repeat,
      };
      builds.set(key, newItem(ref, transcript, personShare));
    }
  }
  const items: ReportItem[] = [];
  for (const [key, build] of builds) {
    build.item.status = settleStatus(build, byKey.has(key));
    if (build.softNotes.length > 0) {
      build.item.note = [
        build.item.note,
        `Reference scores: ${build.softNotes.join(", ")}.`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    }
    if (
      build.item.simulatedUserFlags.length === 0 &&
      (byKey.get(key)?.simulatedUserFlags.length ?? 0) > 0
    ) {
      build.item.simulatedUserFlags = (
        byKey.get(key)?.simulatedUserFlags ?? []
      ).map((flagName) => ({
        evidence: "",
        flag: flagName,
        reason: "Flagged while the conversation ran.",
        turn: 0,
      }));
    }
    items.push(build.item);
  }
  return items.sort(
    (a, b) =>
      a.person.localeCompare(b.person) ||
      a.itemId.localeCompare(b.itemId) ||
      a.repeat - b.repeat
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** The median of numbers. Null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest-rank percentile (`p` from 0 to 100). Null for an empty list. */
export function percentile(
  values: readonly number[],
  p: number
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation. Null with fewer than two values. */
export function spread(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const center = mean(values) ?? 0;
  const variance =
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * The wait for the first word of every assistant turn, in ms. A turn that never
 * showed a word counts at its total time: the wait was at least that long, and
 * leaving it out would let a setup that mostly never answers pass.
 */
export function firstWordWaits(
  transcripts: readonly TranscriptRow[]
): number[] {
  const waits: number[] = [];
  for (const row of transcripts) {
    for (const turn of row.turns) {
      const { timing } = turn;
      if (turn.role !== "assistant" || timing === undefined) {
        continue;
      }
      waits.push(timing.firstVisibleMs ?? timing.totalMs);
    }
  }
  return waits;
}

interface SpeedVerdict {
  detail: string;
  failed: boolean;
}

/** The `fast-enough` hard check: the median wait, and the p90 when the sweep sets a limit. */
export function speedVerdict(
  medianMs: number | null,
  p90Ms: number | null,
  sweep: Pick<SweepFile, "p90LimitSeconds" | "speedLimitSeconds">
): SpeedVerdict {
  const problems: string[] = [];
  if (medianMs !== null && medianMs > sweep.speedLimitSeconds * 1000) {
    problems.push(
      `median wait for the first word was ${(medianMs / 1000).toFixed(1)} s, over the ${sweep.speedLimitSeconds} s limit`
    );
  }
  if (
    sweep.p90LimitSeconds !== null &&
    p90Ms !== null &&
    p90Ms > sweep.p90LimitSeconds * 1000
  ) {
    problems.push(
      `slowest 10% waited ${(p90Ms / 1000).toFixed(1)} s for the first word, over the ${sweep.p90LimitSeconds} s limit`
    );
  }
  return { detail: problems.join("; "), failed: problems.length > 0 };
}

function allChecks(item: ReportItem): ReportCheck[] {
  return [...item.checks, ...item.turns.flatMap((turn) => turn.checks)];
}

function allRubric(item: ReportItem): ReportRubric[] {
  return [...item.rubric, ...item.turns.flatMap((turn) => turn.rubric)];
}

/** The rubric mean of each repeat, then their spread. */
function rubricByRepeat(items: readonly ReportItem[]): number[] {
  const byRepeat = new Map<number, number[]>();
  for (const item of items) {
    for (const rubric of allRubric(item)) {
      if (rubric.score !== null) {
        byRepeat.set(item.repeat, [
          ...(byRepeat.get(item.repeat) ?? []),
          rubric.score,
        ]);
      }
    }
  }
  return [...byRepeat.values()].flatMap((scores) => {
    const average = mean(scores);
    return average === null ? [] : [average];
  });
}

interface HardTally {
  count: number;
  detail: string;
}

interface Tally {
  counted: Map<string, { failures: number; graded: number }>;
  hard: Map<HardCheckId, HardTally>;
  /** Slips and search metrics, which are counted and shown and never ranked on. */
  soft: Map<string, { failures: number; graded: number }>;
}

/**
 * Counts hard failures, and counted passes and failures. A hard failure counts
 * in any item that applies, because it is a failure however the rest went. The
 * counted checks count only in graded items, so the failures and the graded
 * items they are divided by come from the same set. An item that was not graded
 * (the spending cap, a judge error) says nothing about the rate.
 */
function tallyChecks(items: readonly ReportItem[]): Tally {
  const tally: Tally = { counted: new Map(), hard: new Map(), soft: new Map() };
  for (const item of items) {
    if (item.status === "skipped") {
      continue;
    }
    for (const check of allChecks(item)) {
      if (check.outcome === "pass" || check.outcome === "fail") {
        tallyCheck(tally, check, item.status === "graded");
      }
    }
  }
  return tally;
}

function tallyCheck(tally: Tally, check: ReportCheck, graded: boolean): void {
  const tier = CHECK_TIERS[check.id];
  if (tier === "hard" && check.outcome === "fail") {
    const id = check.id as HardCheckId;
    const seen = tally.hard.get(id);
    tally.hard.set(id, {
      count: (seen?.count ?? 0) + 1,
      detail: seen?.detail ?? check.reason.slice(0, 240),
    });
  } else if (
    (tier === "counted" || tier === "slip" || tier === "search") &&
    graded
  ) {
    const into = tier === "counted" ? tally.counted : tally.soft;
    const seen = into.get(check.id) ?? { failures: 0, graded: 0 };
    seen.graded += 1;
    if (check.outcome === "fail") {
      seen.failures += 1;
    }
    into.set(check.id, seen);
  }
}

/** The hard checks the runner decides itself: the speed limits and the swap limit. */
function addRunnerHardFailures(
  hard: Map<HardCheckId, HardTally>,
  waits: { medianMs: number | null; p90Ms: number | null },
  sweep: SweepFile,
  swap: SwapReading | undefined
): void {
  const speed = speedVerdict(waits.medianMs, waits.p90Ms, sweep);
  if (speed.failed && !hard.has("fast-enough")) {
    hard.set("fast-enough", { count: 1, detail: speed.detail });
  }
  const growth = swap?.swapGrowthMB;
  if (
    growth !== null &&
    growth !== undefined &&
    growth > sweep.maxSwapGrowthMB &&
    !hard.has("fits-in-memory")
  ) {
    hard.set("fits-in-memory", {
      count: 1,
      detail: `swap grew ${growth.toFixed(0)} MB, over the ${sweep.maxSwapGrowthMB} MB limit`,
    });
  }
}

function countedSummary(
  counted: Tally["counted"]
): SetupSummary["countedByCheck"] {
  return [...counted.entries()]
    .map(([id, value]) => ({
      failures: value.failures,
      graded: value.graded,
      id: id as SetupSummary["countedByCheck"][number]["id"],
      rate: value.graded === 0 ? 0 : value.failures / value.graded,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Each slip and search metric as a count and a rate, over the turns where it applied. */
function softSummary(soft: Tally["soft"]): SetupSummary["softByCheck"] {
  return [...soft.entries()]
    .map(([id, value]) => ({
      failures: value.failures,
      graded: value.graded,
      id: id as SetupSummary["softByCheck"][number]["id"],
      rate: value.graded === 0 ? 0 : value.failures / value.graded,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Searches, reads, tool calls, and time in tools over the assistant turns of
 * the transcripts. A setup with memory off leaves the memory tool out, as the
 * search checks do.
 */
export function summarizeToolUse(
  transcripts: readonly TranscriptRow[],
  memory: boolean
): SetupSummary["toolUse"] {
  const total = { reads: 0, searches: 0, toolCalls: 0, toolMs: 0, turns: 0 };
  for (const row of transcripts) {
    for (const turn of row.turns) {
      if (turn.role !== "assistant") {
        continue;
      }
      const use = toolUseOf(turn.toolCalls, memory);
      total.reads += use.reads;
      total.searches += use.searches;
      total.toolCalls += use.toolCalls;
      total.toolMs += turn.timing?.toolMs ?? 0;
      total.turns += 1;
    }
  }
  return total;
}

export function summarize(
  items: readonly ReportItem[],
  transcripts: readonly TranscriptRow[],
  sweep: SweepFile,
  extras: { costUsd: number; memory?: boolean; swap?: SwapReading }
): SetupSummary {
  const graded = items.filter((item) => item.status === "graded").length;
  const tally = tallyChecks(items);
  const waits = firstWordWaits(transcripts);
  const medianMs = median(waits);
  const p90Ms = percentile(waits, 90);
  addRunnerHardFailures(tally.hard, { medianMs, p90Ms }, sweep, extras.swap);

  const countedByCheck = countedSummary(tally.counted);
  const countedFailures = countedByCheck.reduce(
    (sum, check) => sum + check.failures,
    0
  );
  const rubricScores = items.flatMap((item) =>
    allRubric(item).flatMap((rubric) =>
      rubric.score === null ? [] : [rubric.score]
    )
  );
  return {
    costUsd: extras.costUsd,
    countedByCheck,
    countedFailures,
    countedRate: graded === 0 ? 0 : countedFailures / graded,
    firstWordMedianMs: medianMs,
    firstWordP90Ms: p90Ms,
    graded,
    hardFailures: [...tally.hard.entries()]
      .map(([id, value]) => ({ count: value.count, detail: value.detail, id }))
      .sort(
        (a, b) => HARD_CHECK_IDS.indexOf(a.id) - HARD_CHECK_IDS.indexOf(b.id)
      ),
    modelSizeMB: extras.swap?.modelSizeMB ?? null,
    notGraded: items.filter((item) => item.status === "not-graded").length,
    rubricMean: mean(rubricScores),
    rubricSpread: spread(rubricByRepeat(items)),
    skipped: items.filter((item) => item.status === "skipped").length,
    softByCheck: softSummary(tally.soft),
    swapBaselineMB: extras.swap?.swapBaselineMB ?? null,
    swapGrowthMB: extras.swap?.swapGrowthMB ?? null,
    toolUse: summarizeToolUse(transcripts, extras.memory ?? false),
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** The rubric hash the judge records in the metadata of each check it graded. */
export function rubricVersionOf(rows: readonly PassRow[]): string | undefined {
  for (const { row } of rows) {
    for (const assertion of row.assertions) {
      const found = text(assertion.metadata, "rubric");
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * The rows a setup report is made from. The judge check runs before any setup
 * and belongs to the sweep, so its rows (and its cost) stay out of every setup.
 */
export function setupRows(rows: readonly PassRow[]): PassRow[] {
  return rows.filter((entry) => !isJudgeCheckRow(entry.row));
}

export function assembleSetupReport(input: AssembleInput): SetupReport {
  const rows = setupRows(input.rows);
  const items = buildItems(rows, input.transcripts, input.personShare ?? 1);
  const people = [
    ...new Set([...input.people, ...items.map((item) => item.person)]),
  ].sort();
  const rubric = rubricVersionOf(rows);
  const report: SetupReport = {
    gitCommit: input.gitCommit,
    items,
    judge: input.sweep.judge,
    people,
    promptShas: {
      ...input.promptShas,
      ...(rubric === undefined ? {} : { rubric }),
    },
    schemaVersion: REPORT_SCHEMA_VERSION,
    setup: input.setup,
    setupId: setupIdOf(input.setup),
    simulatedUser: input.sweep.simulatedUser,
    summary: summarize(items, input.transcripts, input.sweep, {
      costUsd: judgeCostOf(rows, input.personShare ?? 1),
      memory: input.setup.memory === "on",
      swap: input.swap,
    }),
    sweepId: input.sweepId,
  };
  return parseSetupReport(report, `report for setup ${report.setupId}`);
}

export interface SweepSummaryInput {
  actual: { costUsd: number | null; hours: number | null };
  estimate: { costUsd: number; hours: number };
  judgeCheck: SweepSummary["judgeCheck"];
  reports: readonly SetupReport[];
  sweep: SweepFile;
  /** The file the sweep came from, such as `smoke.yaml`. */
  sweepFile: string;
  sweepId: string;
}

export function assembleSweepSummary(input: SweepSummaryInput): SweepSummary {
  const ranking: RankingEntry[] = rankSetups(
    input.reports.map((report) => rankingEntryFor(report))
  );
  return parseSweepSummary(
    {
      actual: input.actual,
      estimate: input.estimate,
      judgeCheck: input.judgeCheck,
      ranking,
      schemaVersion: REPORT_SCHEMA_VERSION,
      sweep: input.sweep,
      sweepFile: input.sweepFile,
      sweepId: input.sweepId,
    },
    "sweep summary"
  );
}

/** Writes the setup reports and the sweep summary. Returns the paths. */
export function writeReports(
  reportsDir: string,
  reports: readonly SetupReport[],
  summary: SweepSummary
): string[] {
  mkdirSync(reportsDir, { recursive: true });
  const written: string[] = [];
  for (const report of reports) {
    const path = join(
      reportsDir,
      reportFileName(report.sweepId, report.setupId)
    );
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    written.push(path);
  }
  const summaryPath = join(reportsDir, sweepSummaryFileName(summary.sweepId));
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  written.push(summaryPath);
  return written;
}

/** One line per setup, best first, for the end of a run. */
export function describeRanking(
  summary: SweepSummary,
  reports: readonly SetupReport[]
): string[] {
  const byId = new Map(reports.map((report) => [report.setupId, report]));
  return summary.ranking.map((entry, index) => {
    const report = byId.get(entry.setupId);
    const setup = report?.setup;
    const name =
      setup === undefined
        ? entry.setupId
        : `${setup.chatModel} / ${setup.prompt} / think ${setup.thinking} / ctx ${setup.contextLength} / mem ${setup.memory}`;
    const verdict = entry.passedHard
      ? "passed every hard check"
      : `failed ${entry.hardFailed.join(", ")}`;
    const rubric =
      entry.rubricMean === null
        ? "no rubric"
        : `rubric ${entry.rubricMean.toFixed(2)}`;
    const incomplete = entry.incomplete ? " (incomplete)" : "";
    return `${index + 1}. ${name}: ${verdict}, ${entry.countedRate.toFixed(2)} counted failures per item, ${rubric}${incomplete} [${entry.setupId}]`;
  });
}
