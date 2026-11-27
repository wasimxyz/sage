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

/** A tool call on an assistant turn. `output` is missing when the call never resolved. */
export interface ToolCallView {
  input: unknown;
  name: string;
  output?: unknown;
  status: string;
}

/** A wrong statement about the journal, with what the journal says instead. */
export interface JournalErrorView {
  evidence: string;
  kind: string;
  reason: string;
  truth: string;
}

export interface ReportTurn {
  checks: CheckResult[];
  error?: string;
  /** What kind of message this turn answers, when the report says. A conversation can change kind turn by turn. */
  expect?: string;
  firstVisibleMs: number | null;
  helpSeen: string[];
  journalErrors: JournalErrorView[];
  /** 1-based position in the item. */
  position: number;
  role: string;
  rubric: RubricResult[];
  stepModelIds: string[];
  text: string;
  toolCalls: ToolCallView[];
  toolMs: number | null;
  totalMs: number | null;
}

/** The judge's mark of one exchange: did the person return to the same worry, and did the reply feed it. */
export interface LoopMark {
  evidence: string;
  feedsLoop: boolean | null;
  reason: string;
  returnsToWorry: boolean;
  /** The 1-based exchange: the person's message and Sage's reply. */
  turn: number;
}

/** The judge's mark of one exchange after the person said no to something. */
export interface DeclineMark {
  afterNo: boolean;
  bringsItBack: boolean | null;
  evidence: string;
  reason: string;
  /** The 1-based exchange. */
  turn: number;
}

/** A way the simulated user slipped after a crisis turn. */
export interface SimulatedUserFlagMark {
  evidence: string;
  flag: string;
  reason: string;
  /** The 1-based exchange. */
  turn: number;
}

export interface UnsupportedClaim {
  itemKind: string;
  /** The text of the Dream item that holds the claim. */
  itemText: string;
  /** The words the source does not support. */
  quote: string;
  reason: string;
  /** `severe` or `other`. */
  severity: string;
}

export interface DreamWritten {
  itemKind: string;
  text: string;
}

/** One entry or chat, with everything Dream wrote from it. */
export interface DreamSource {
  sourceId: string;
  /** `entry` or `chat`. */
  sourceKind: string;
  sourceText: string;
  unsupportedClaims: UnsupportedClaim[];
  written: DreamWritten[];
}

export interface ReportItem {
  checks: CheckResult[];
  costUsd: number;
  declineMarks: DeclineMark[];
  dream?: DreamSource;
  ended?: string;
  /** What the item expects of the reply. Reports do not carry it yet, so it is usually missing. */
  expect?: string;
  itemId: string;
  journal: string;
  kind: string;
  loopMarks: LoopMark[];
  note?: string;
  person: string;
  repeat: number;
  rubric: RubricResult[];
  simulatedUserFlags: SimulatedUserFlagMark[];
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

/** What Chat did with its tools, over the assistant turns of the setup. */
export interface ToolUse {
  reads: number;
  searches: number;
  toolCalls: number;
  toolMs: number;
  turns: number;
}

/** How the simulated user held up after a crisis turn. */
export interface SimulatedUserStats {
  crisisConversations: number;
  flagged: number;
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
  simulatedUser: SimulatedUserStats;
  skipped: number;
  /** Slips and search metrics. They are counted and shown, never ranked on. */
  softByCheck: CountedByCheck[];
  swapBaselineMB: number | null;
  swapGrowthMB: number | null;
  toolUse: ToolUse;
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
