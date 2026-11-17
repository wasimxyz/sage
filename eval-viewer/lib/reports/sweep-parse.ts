import {
  type CheckResult,
  type CountedByCheck,
  type DimensionKey,
  dimensionKeys,
  type HardFailure,
  type JudgeCheckMiss,
  type ParseOutcome,
  type RankingEntry,
  type ReportItem,
  type ReportTurn,
  type RubricResult,
  type SetupDimensions,
  type SetupReport,
  type SetupSummary,
  type SweepAxes,
  type SweepSummary,
  supportedSchemaVersion,
} from "./sweep-types.ts";

// A tolerant reader for the JSON that agent/evals/lib/schema.ts describes.
// Fields it does not know are ignored. A missing field the schema defaults is
// filled in. A field with the wrong type, or a missing required one, names its
// path in the message. Another schema version is "unsupported".

type Obj = Record<string, unknown>;

class ShapeError extends Error {}

const axisKeys: Record<DimensionKey, string> = {
  chatModel: "chatModels",
  contextLength: "contextLengths",
  dreamPrompt: "dreamPrompts",
  embedModel: "embedModels",
  memory: "memory",
  prompt: "prompts",
  summaryModel: "summaryModels",
  thinking: "thinking",
};

export function parseSetupReport(raw: string): ParseOutcome<SetupReport> {
  return parseWith(raw, readSetupReport);
}

export function parseSweepSummary(raw: string): ParseOutcome<SweepSummary> {
  return parseWith(raw, readSweepSummary);
}

function parseWith<T>(raw: string, read: (root: Obj) => T): ParseOutcome<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", message: "The file is not valid JSON." };
  }
  try {
    const root = object(json, "The report");
    const unsupported = versionProblem(root);
    if (unsupported !== undefined) {
      return { kind: "unsupported", message: unsupported };
    }
    return { kind: "ok", value: read(root) };
  } catch (error) {
    if (error instanceof ShapeError) {
      return { kind: "invalid", message: error.message };
    }
    throw error;
  }
}

function versionProblem(root: Obj): string | undefined {
  const version = root.schemaVersion;
  if (version === supportedSchemaVersion) {
    return;
  }
  const seen =
    version === undefined
      ? "no schema version"
      : `schema version ${JSON.stringify(version)}`;
  return `This report has ${seen}. This viewer reads version ${supportedSchemaVersion}.`;
}

// --- readers ---------------------------------------------------------------

function readSetupReport(root: Obj): SetupReport {
  const promptShas = object(root.promptShas ?? {}, "promptShas");
  return {
    gitCommit: textOr(root, "gitCommit", "", ""),
    items: list(root, "items", readItem),
    judgeModel: textOr(object(root.judge ?? {}, "judge"), "model", "", "judge"),
    people: textList(root, "people"),
    promptShas: {
      chat: textOr(promptShas, "chat", "", "promptShas"),
      dream: optionalText(promptShas, "dream", "promptShas") ?? null,
      rubric: optionalText(promptShas, "rubric", "promptShas"),
    },
    setup: readDimensions(object(root.setup, "setup")),
    setupId: requiredText(root, "setupId", ""),
    summary: readSetupSummary(object(root.summary, "summary")),
    sweepId: requiredText(root, "sweepId", ""),
  };
}

function readDimensions(setup: Obj): SetupDimensions {
  return {
    chatModel: requiredText(setup, "chatModel", "setup"),
    contextLength: requiredNumber(setup, "contextLength", "setup"),
    dreamPrompt: requiredText(setup, "dreamPrompt", "setup"),
    embedModel: requiredText(setup, "embedModel", "setup"),
    memory: requiredText(setup, "memory", "setup"),
    prompt: requiredText(setup, "prompt", "setup"),
    summaryModel: requiredText(setup, "summaryModel", "setup"),
    thinking: requiredText(setup, "thinking", "setup"),
  };
}

function readSetupSummary(summary: Obj): SetupSummary {
  const at = "summary";
  return {
    costUsd: numberOr(summary, "costUsd", 0, at),
    countedByCheck: list(summary, "countedByCheck", readCountedByCheck, at),
    countedFailures: requiredNumber(summary, "countedFailures", at),
    countedRate: requiredNumber(summary, "countedRate", at),
    firstWordMedianMs: nullableNumber(summary, "firstWordMedianMs", at),
    firstWordP90Ms: nullableNumber(summary, "firstWordP90Ms", at),
    graded: requiredNumber(summary, "graded", at),
    hardFailures: list(summary, "hardFailures", readHardFailure, at),
    modelSizeMB: nullableNumber(summary, "modelSizeMB", at),
    notGraded: numberOr(summary, "notGraded", 0, at),
    rubricMean: nullableNumber(summary, "rubricMean", at),
    rubricSpread: nullableNumber(summary, "rubricSpread", at),
    skipped: numberOr(summary, "skipped", 0, at),
    swapBaselineMB: nullableNumber(summary, "swapBaselineMB", at),
    swapGrowthMB: nullableNumber(summary, "swapGrowthMB", at),
  };
}

function readHardFailure(value: unknown, path: string): HardFailure {
  const failure = object(value, path);
  return {
    count: numberOr(failure, "count", 1, path),
    detail: textOr(failure, "detail", "", path),
    id: requiredText(failure, "id", path),
  };
}

function readCountedByCheck(value: unknown, path: string): CountedByCheck {
  const check = object(value, path);
  return {
    failures: requiredNumber(check, "failures", path),
    graded: requiredNumber(check, "graded", path),
    id: requiredText(check, "id", path),
    rate: requiredNumber(check, "rate", path),
  };
}

function readItem(value: unknown, path: string): ReportItem {
  const item = object(value, path);
  return {
    checks: list(item, "checks", readCheck, path),
    costUsd: numberOr(item, "costUsd", 0, path),
    ended: optionalText(item, "ended", path),
    itemId: requiredText(item, "itemId", path),
    journal: textOr(item, "journal", "own", path),
    kind: textOr(item, "kind", "", path),
    note: optionalText(item, "note", path),
    person: textOr(item, "person", "", path),
    repeat: numberOr(item, "repeat", 1, path),
    rubric: list(item, "rubric", readRubric, path),
    status: textOr(item, "status", "graded", path),
    turns: list(item, "turns", readTurn, path),
  };
}

function readTurn(value: unknown, path: string, index: number): ReportTurn {
  const turn = object(value, path);
  const timing = turn.timing === undefined ? {} : object(turn.timing, path);
  return {
    checks: list(turn, "checks", readCheck, path),
    error: optionalText(turn, "error", path),
    firstVisibleMs: nullableNumber(timing, "firstVisibleMs", `${path}.timing`),
    helpSeen: textList(turn, "helpSeen", path),
    position: index + 1,
    role: textOr(turn, "role", "assistant", path),
    rubric: list(turn, "rubric", readRubric, path),
    text: textOr(turn, "text", "", path),
  };
}

function readCheck(value: unknown, path: string): CheckResult {
  const check = object(value, path);
  return {
    evidence: textOr(check, "evidence", "", path),
    id: requiredText(check, "id", path),
    outcome: requiredText(check, "outcome", path),
    reason: textOr(check, "reason", "", path),
  };
}

function readRubric(value: unknown, path: string): RubricResult {
  const rubric = object(value, path);
  return {
    evidence: textOr(rubric, "evidence", "", path),
    id: requiredText(rubric, "id", path),
    level: nullableNumber(rubric, "level", path),
    reason: textOr(rubric, "reason", "", path),
    score: nullableNumber(rubric, "score", path),
  };
}

function readSweepSummary(root: Obj): SweepSummary {
  const sweep = object(root.sweep ?? {}, "sweep");
  const judgeCheck = object(root.judgeCheck ?? {}, "judgeCheck");
  const estimate = object(root.estimate ?? {}, "estimate");
  const actual = object(root.actual ?? {}, "actual");
  return {
    actual: {
      costUsd: nullableNumber(actual, "costUsd", "actual"),
      hours: nullableNumber(actual, "hours", "actual"),
    },
    axes: readAxes(sweep),
    estimate: {
      costUsd: numberOr(estimate, "costUsd", 0, "estimate"),
      hours: numberOr(estimate, "hours", 0, "estimate"),
    },
    judgeCheckMisses: list(judgeCheck, "misses", readMiss, "judgeCheck"),
    judgeCheckPassed: requiredBoolean(judgeCheck, "passed", "judgeCheck"),
    judgeModel:
      optionalText(
        object(sweep.judge ?? {}, "sweep.judge"),
        "model",
        "sweep.judge"
      ) ?? null,
    ranking: list(root, "ranking", readRankingEntry),
    repeats: nullableNumber(sweep, "repeats", "sweep"),
    sweepFile: textOr(root, "sweepFile", "", ""),
    sweepId: requiredText(root, "sweepId", ""),
    tags: textList(sweep, "tags", "sweep"),
    tests: textList(sweep, "tests", "sweep"),
  };
}

function readAxes(sweep: Obj): SweepAxes {
  const axes: SweepAxes = {};
  for (const key of dimensionKeys) {
    const values = sweep[axisKeys[key]];
    if (Array.isArray(values)) {
      axes[key] = values.filter(
        (value): value is number | string =>
          typeof value === "string" || typeof value === "number"
      );
    }
  }
  return axes;
}

function readMiss(value: unknown, path: string): JudgeCheckMiss {
  const miss = object(value, path);
  return {
    check: textOr(miss, "check", "", path),
    detail: textOr(miss, "detail", "", path),
    itemId: textOr(miss, "itemId", "", path),
    kind: textOr(miss, "kind", "missed", path),
  };
}

function readRankingEntry(value: unknown, path: string): RankingEntry {
  const entry = object(value, path);
  return {
    countedRate: requiredNumber(entry, "countedRate", path),
    firstWordMedianMs: nullableNumber(entry, "firstWordMedianMs", path),
    hardFailed: textList(entry, "hardFailed", path),
    incomplete: booleanOr(entry, "incomplete", false, path),
    passedHard: requiredBoolean(entry, "passedHard", path),
    rubricMean: nullableNumber(entry, "rubricMean", path),
    setupId: requiredText(entry, "setupId", path),
    spread: nullableNumber(entry, "spread", path),
  };
}

// --- small readers ---------------------------------------------------------

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function fail(path: string, expected: string): never {
  throw new ShapeError(`${path}: expected ${expected}.`);
}

function object(value: unknown, path: string): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "an object");
  }
  return value as Obj;
}

function requiredText(source: Obj, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    return fail(join(path, key), "text");
  }
  return value;
}

function optionalText(
  source: Obj,
  key: string,
  path: string
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    return fail(join(path, key), "text");
  }
  return value;
}

function textOr(
  source: Obj,
  key: string,
  fallback: string,
  path: string
): string {
  return optionalText(source, key, path) ?? fallback;
}

function requiredNumber(source: Obj, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fail(join(path, key), "a number");
  }
  return value;
}

function nullableNumber(source: Obj, key: string, path: string): number | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  return requiredNumber(source, key, path);
}

function numberOr(
  source: Obj,
  key: string,
  fallback: number,
  path: string
): number {
  return nullableNumber(source, key, path) ?? fallback;
}

function requiredBoolean(source: Obj, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    return fail(join(path, key), "true or false");
  }
  return value;
}

function booleanOr(
  source: Obj,
  key: string,
  fallback: boolean,
  path: string
): boolean {
  return source[key] === undefined
    ? fallback
    : requiredBoolean(source, key, path);
}

function list<T>(
  source: Obj,
  key: string,
  read: (value: unknown, path: string, index: number) => T,
  path = ""
): T[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return fail(join(path, key), "a list");
  }
  return value.map((child, index) =>
    read(child, `${join(path, key)}[${index}]`, index)
  );
}

function textList(source: Obj, key: string, path = ""): string[] {
  return list(
    source,
    key,
    (value, childPath) => {
      if (typeof value !== "string") {
        return fail(childPath, "text");
      }
      return value;
    },
    path
  );
}
