import { fixtureCatalog } from "./fixtures.ts";
import { parseJUnitXml } from "./junit.ts";
import { parseManifest } from "./manifest.ts";
import { parseRunId } from "./run-id.ts";
import { parseSageLog } from "./sage-log.ts";
import {
  type CategoryId,
  type CategorySummary,
  categoryIds,
  type EvalReport,
  type FailureRecord,
  type ReportFiles,
  type RunSummary,
  type ScenarioRow,
} from "./types.ts";

const categoryLabels: Record<CategoryId, string> = {
  chat: "Chat",
  extraction: "Extraction",
  retrieval: "Retrieval",
  summaries: "Summaries",
};

export function assembleReport(id: string, files: ReportFiles): EvalReport {
  const parsedId = parseRunId(id);
  const suite = parseJUnitXml(files.xml);
  const log = files.log === undefined ? undefined : parseSageLog(files.log);
  const manifest =
    files.manifest === undefined
      ? { cases: {} }
      : parseManifest(files.manifest);
  const categories = categoryIds.map((categoryId) =>
    categorySummary(categoryId, suite.failures, suite.passedDurations)
  );
  const { scenarios, unmatchedPrompts } = matchScenarios(
    suite.failures,
    manifest.cases
  );
  const endedAt =
    log?.endedAt ?? addSeconds(parsedId.startedAt, suite.suiteSeconds);
  const run: EvalReport["run"] = {
    app: log?.app ?? "Sage",
    chatModel: parsedId.chatModel,
    dreamModel: parsedId.dreamModel,
    embedModel: parsedId.embedModel,
    endedAt,
    failed: suite.failed,
    id,
    infraFailed: infraFailureCount(suite.failures),
    passed: suite.passed,
    platform: log?.platform ?? "unknown",
    sessionSeconds: log?.sessionSeconds,
    startedAt: parsedId.startedAt,
    suiteSeconds: suite.suiteSeconds,
    total: suite.total,
  };
  return {
    categories,
    chatScores: suite.chatScores,
    failures: suite.failures,
    id,
    models: {
      chatModel: parsedId.chatModel,
      dreamModel: parsedId.dreamModel,
      embedModel: parsedId.embedModel,
    },
    passedDurations: suite.passedDurations,
    run,
    scenarios,
    unmatchedPrompts,
  };
}

export function summaryFromXml(id: string, xml: string): RunSummary {
  const parsedId = parseRunId(id);
  const suite = parseJUnitXml(xml);
  return {
    chatModel: parsedId.chatModel,
    dreamModel: parsedId.dreamModel,
    embedModel: parsedId.embedModel,
    failed: suite.failed,
    id,
    infraFailed: infraFailureCount(suite.failures),
    passed: suite.passed,
    startedAt: parsedId.startedAt,
    suiteSeconds: suite.suiteSeconds,
    total: suite.total,
  };
}

function categorySummary(
  id: CategoryId,
  failures: FailureRecord[],
  passedDurations: Partial<Record<CategoryId, number[]>>
): CategorySummary {
  const times = passedDurations[id] ?? [];
  const failed = failures.filter((item) => item.category === id).length;
  const passed = times.length;
  const total = passed + failed;
  return {
    avg: average(times),
    failed,
    id,
    label: categoryLabels[id],
    max: times.length === 0 ? 0 : Math.max(...times),
    min: times.length === 0 ? 0 : Math.min(...times),
    passed,
    total,
  };
}

function matchScenarios(
  failures: FailureRecord[],
  cases: Record<string, { journalIds: number[] }>
): { scenarios: ScenarioRow[]; unmatchedPrompts: string[] } {
  const promptsByCase = new Map<string, string[]>();
  const unmatchedPrompts: string[] = [];
  const journalToCase = journalIndex(cases);

  for (const failure of failures) {
    if (matchChatPrompt(failure, promptsByCase, unmatchedPrompts)) {
      continue;
    }
    matchRetrievalHit(failure, journalToCase, promptsByCase);
  }

  return {
    scenarios: scenarioRows(cases, promptsByCase),
    unmatchedPrompts,
  };
}

function journalIndex(
  cases: Record<string, { journalIds: number[] }>
): Map<number, string> {
  const journalToCase = new Map<number, string>();
  for (const [caseId, value] of Object.entries(cases)) {
    for (const journalId of value.journalIds) {
      journalToCase.set(journalId, caseId);
    }
  }
  return journalToCase;
}

function matchChatPrompt(
  failure: FailureRecord,
  promptsByCase: Map<string, string[]>,
  unmatchedPrompts: string[]
): boolean {
  const prompt = failure.judge?.prompt.trim() ?? "";
  if (prompt.length === 0) {
    return false;
  }
  const fixture = fixtureCatalog.find((item) =>
    item.chatQuestions.includes(prompt)
  );
  if (fixture === undefined) {
    unmatchedPrompts.push(prompt);
    return true;
  }
  const list = promptsByCase.get(fixture.id) ?? [];
  if (!list.includes(prompt)) {
    list.push(prompt);
  }
  promptsByCase.set(fixture.id, list);
  return true;
}

function matchRetrievalHit(
  failure: FailureRecord,
  journalToCase: Map<number, string>,
  promptsByCase: Map<string, string[]>
): void {
  if (failure.retrieval === undefined) {
    return;
  }
  const expectedId = Number.parseInt(failure.retrieval.expected, 10);
  const caseId = Number.isNaN(expectedId)
    ? undefined
    : journalToCase.get(expectedId);
  if (caseId !== undefined && !promptsByCase.has(caseId)) {
    promptsByCase.set(caseId, []);
  }
}

function scenarioRows(
  cases: Record<string, { journalIds: number[] }>,
  promptsByCase: Map<string, string[]>
): ScenarioRow[] {
  const caseIds = new Set([
    ...Object.keys(cases),
    ...fixtureCatalog.map((item) => item.id),
  ]);
  return [...caseIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const fixture = fixtureCatalog.find((item) => item.id === id);
      const journalIds = cases[id]?.journalIds;
      return {
        entries: journalIds?.length ?? fixture?.entries ?? 0,
        id,
        kind: fixture?.kind ?? "unknown",
        matchedPrompts: promptsByCase.get(id) ?? [],
      };
    });
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addSeconds(iso: string, seconds: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function infraFailureCount(failures: FailureRecord[]): number {
  return failures.filter(
    (item) => item.type === "call_failed" || item.type === "timeout"
  ).length;
}
