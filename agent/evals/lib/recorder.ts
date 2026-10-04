import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EveEvalResult } from "eve/evals";
import type {
  EvalReporter,
  EveEvalCompleteContext,
} from "eve/evals/reporters";

export interface RecordedAssertion {
  errored?: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
  name: string;
  passed: boolean;
  score: number;
  severity: string;
  threshold?: number;
}

export interface RecordedEvalResult {
  assertions: RecordedAssertion[];
  completedAt: string;
  error?: string;
  id: string;
  metadata: Record<string, unknown>;
  skipReason?: string;
  startedAt: string;
  verdict: string;
}

export function sageEvalRecorder(path: string): EvalReporter {
  return {
    onEvalComplete(result: EveEvalResult, context?: EveEvalCompleteContext) {
      const row: RecordedEvalResult = {
        assertions: result.assertions.map((assertion) => ({
          errored: assertion.errored,
          message: assertion.message,
          metadata:
            assertion.metadata === undefined
              ? undefined
              : { ...assertion.metadata },
          name: assertion.name,
          passed: assertion.passed,
          score: assertion.score,
          severity: assertion.severity,
          threshold: assertion.threshold,
        })),
        completedAt: result.completedAt,
        error: result.error,
        id: result.id,
        metadata: { ...(context?.evaluation.metadata ?? {}) },
        skipReason: result.skipReason,
        startedAt: result.startedAt,
        verdict: result.verdict,
      };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
    },
    onRunComplete() {},
    onRunStart() {},
  };
}

export function loadRecordedResults(path: string): RecordedEvalResult[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const rows: RecordedEvalResult[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(trimmed, path, offset + 1));
  }
  return rows;
}

function parseRow(
  line: string,
  path: string,
  lineNumber: number
): RecordedEvalResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`${path}:${lineNumber} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path}:${lineNumber} must be a JSON object.`);
  }
  const row = parsed as Record<string, unknown>;
  const label = `${path}:${lineNumber}`;
  return {
    assertions: assertionList(row.assertions, label),
    completedAt: requiredString(row, "completedAt", label),
    error: optionalString(row.error),
    id: requiredString(row, "id", label),
    metadata: objectRecord(row.metadata, label),
    skipReason: optionalString(row.skipReason),
    startedAt: requiredString(row, "startedAt", label),
    verdict: requiredString(row, "verdict", label),
  };
}

function assertionList(value: unknown, label: string): RecordedAssertion[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} assertions must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${label} assertions[${index}] must be an object.`);
    }
    const row = item as Record<string, unknown>;
    const name = row.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`${label} assertions[${index}] is missing name.`);
    }
    return {
      errored: typeof row.errored === "boolean" ? row.errored : undefined,
      message: optionalString(row.message),
      metadata:
        row.metadata === undefined
          ? undefined
          : objectRecord(row.metadata, `${label} assertions[${index}]`),
      name,
      passed: row.passed === true,
      score: typeof row.score === "number" ? row.score : 0,
      severity: typeof row.severity === "string" ? row.severity : "soft",
      threshold: typeof row.threshold === "number" ? row.threshold : undefined,
    };
  });
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} metadata must be an object.`);
  }
  return { ...(value as Record<string, unknown>) };
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
