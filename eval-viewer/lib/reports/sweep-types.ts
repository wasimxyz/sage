// The viewer is a separate package, so it cannot import agent/. These types
// hold only what the viewer reads from agent/evals/lib/schema.ts
// (setupReportSchema and sweepSummarySchema). Unknown fields are ignored.

export const supportedSchemaVersion = 1;

export type ParseOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "unsupported"; message: string }
  | { kind: "invalid"; message: string };

export const dimensionKeys = [
  "chatModel",
  "prompt",
  "thinking",
  "contextLength",
  "memory",
  "summaryModel",
  "embedModel",
  "dreamPrompt",
] as const;

export type DimensionKey = (typeof dimensionKeys)[number];

export interface SetupDimensions {
  chatModel: string;
  contextLength: number;
  dreamPrompt: string;
  embedModel: string;
  memory: string;
  prompt: string;
  summaryModel: string;
  thinking: string;
}

/** A hard, counted, slip, or search check. `outcome` is pass, fail, skipped, or not-graded. */
export interface CheckResult {
  evidence: string;
  id: string;
  outcome: string;
  reason: string;
}

/** A 1 to 5 rubric score. A null `level` is N/A. */
export interface RubricResult {
  evidence: string;
  id: string;
  level: number | null;
  reason: string;
  score: number | null;
}

export interface ReportTurn {
  checks: CheckResult[];
  error?: string;
  firstVisibleMs: number | null;
  helpSeen: string[];
  /** 1-based position in the item. */
  position: number;
  role: string;
  rubric: RubricResult[];
  text: string;
}

export interface ReportItem {
  checks: CheckResult[];
  costUsd: number;
  ended?: string;
  itemId: string;
  journal: string;
  kind: string;
  note?: string;
  person: string;
  repeat: number;
  rubric: RubricResult[];
  status: string;
  turns: ReportTurn[];
}

export interface HardFailure {
  count: number;
  detail: string;
  id: string;
}

export interface CountedByCheck {
  failures: number;
  graded: number;
  id: string;
  rate: number;
}

export interface SetupSummary {
  costUsd: number;
  countedByCheck: CountedByCheck[];
  countedFailures: number;
  countedRate: number;
  firstWordMedianMs: number | null;
  firstWordP90Ms: number | null;
  graded: number;
  hardFailures: HardFailure[];
  modelSizeMB: number | null;
  notGraded: number;
  rubricMean: number | null;
  rubricSpread: number | null;
  skipped: number;
  swapBaselineMB: number | null;
  swapGrowthMB: number | null;
}

export interface SetupReport {
  gitCommit: string;
  items: ReportItem[];
  judgeModel: string;
  people: string[];
  promptShas: {
    chat: string;
    dream: string | null;
    rubric?: string;
  };
  setup: SetupDimensions;
  setupId: string;
  summary: SetupSummary;
  sweepId: string;
}

export interface RankingEntry {
  countedRate: number;
  firstWordMedianMs: number | null;
  hardFailed: string[];
  incomplete: boolean;
  passedHard: boolean;
  rubricMean: number | null;
  setupId: string;
  spread: number | null;
}

export interface JudgeCheckMiss {
  check: string;
  detail: string;
  itemId: string;
  /** `missed` or `false-alarm`. */
  kind: string;
}

/** The values each sweep file axis lists. An axis the file did not list is missing. */
export type SweepAxes = Partial<Record<DimensionKey, (string | number)[]>>;

export interface SweepSummary {
  actual: { costUsd: number | null; hours: number | null };
  axes: SweepAxes;
  estimate: { costUsd: number; hours: number };
  judgeCheckMisses: JudgeCheckMiss[];
  judgeCheckPassed: boolean;
  judgeModel: string | null;
  ranking: RankingEntry[];
  repeats: number | null;
  sweepFile: string;
  sweepId: string;
  tags: string[];
  tests: string[];
}

/** One sweep on the home page. `top` is the first setup in its ranking. */
export interface SweepListItem {
  date?: string;
  id: string;
  outcome: ParseOutcome<SweepSummary>;
  top?: { entry: RankingEntry; label: string };
}

/** One sweep with the setup reports that were found for it, by setup id. */
export interface SweepData {
  date?: string;
  id: string;
  reports: Map<string, ParseOutcome<SetupReport>>;
  summary: ParseOutcome<SweepSummary>;
}

export interface SetupData {
  outcome: ParseOutcome<SetupReport>;
  setupId: string;
  sweepId: string;
}
