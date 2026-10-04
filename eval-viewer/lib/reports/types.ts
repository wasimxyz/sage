export const categoryIds = [
  "chat",
  "extraction",
  "retrieval",
  "summaries",
] as const;

export type CategoryId = (typeof categoryIds)[number];

export type FailureType = "call_failed" | "timeout" | "wrong_hit" | "other";

export interface ParsedRunId {
  chatModel: string;
  dreamModel: string;
  embedModel: string;
  id: string;
  startedAt: string;
}

export interface AssertionBadge {
  label: string;
  passed: boolean;
  score?: number;
  severity: "gate" | "soft";
}

export interface JudgeDetail {
  choice?: string;
  expected: string;
  judgeModel?: string;
  output: string;
  passed: boolean;
  prompt: string;
  rationale?: string;
  score: number;
}

export interface RetrievalDetail {
  actual: string;
  expected: string;
}

export interface FailureRecord {
  badges: AssertionBadge[];
  category: CategoryId | "other";
  id: string;
  judge?: JudgeDetail;
  message: string;
  retrieval?: RetrievalDetail;
  time: number;
  type: FailureType;
}

export interface ChatScore {
  failed: boolean;
  id: string;
  judge?: JudgeDetail;
  message: string;
  time: number;
}

export interface CategorySummary {
  avg: number;
  failed: number;
  id: CategoryId;
  label: string;
  max: number;
  min: number;
  passed: number;
  total: number;
}

export interface ScenarioRow {
  entries: number;
  id: string;
  kind: string;
  matchedPrompts: string[];
}

export interface SessionLog {
  app: string;
  endedAt?: string;
  platform: string;
  sessionSeconds?: number;
  startedAt?: string;
}

export interface RunSummary {
  chatModel: string;
  dreamModel: string;
  embedModel: string;
  failed: number;
  id: string;
  infraFailed: number;
  passed: number;
  startedAt: string;
  suiteSeconds: number;
  total: number;
}

export interface EvalReport {
  categories: CategorySummary[];
  chatScores: ChatScore[];
  failures: FailureRecord[];
  id: string;
  models: {
    chatModel: string;
    dreamModel: string;
    embedModel: string;
  };
  passedDurations: Partial<Record<CategoryId, number[]>>;
  run: RunSummary & {
    app: string;
    endedAt?: string;
    platform: string;
    sessionSeconds?: number;
  };
  scenarios: ScenarioRow[];
  unmatchedPrompts: string[];
}

export interface ReportFiles {
  log?: string;
  manifest?: string;
  xml: string;
}

export interface FixtureCatalogEntry {
  chatQuestions: string[];
  entries: number;
  id: string;
  kind: string;
}

export interface ManifestCase {
  journalIds: number[];
}

export interface EvalManifest {
  cases: Record<string, ManifestCase>;
}
