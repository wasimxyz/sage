import {
  type AssertionBadge,
  type CategoryId,
  type ChatScore,
  categoryIds,
  type FailureRecord,
  type FailureType,
  type JudgeDetail,
  type RetrievalDetail,
} from "./types.ts";

const categorySet = new Set<string>(categoryIds);
const suiteTagPattern = /<testsuite\b([^>]*)>/;
const testCasePattern =
  /<testcase\b([^>]*)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
const skippedPattern = /<skipped\b/;
const failurePattern =
  /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/;
const systemOutPattern = /<system-out\b[^>]*>([\s\S]*?)<\/system-out>/;
const attributePattern = /(\w+)="([^"]*)"/g;
const expectedCapture = /expected\s+(\S+)/i;
const receivedCapture = /received\s+(\S+)/i;

export interface ParsedSuite {
  chatScores: ChatScore[];
  failed: number;
  failures: FailureRecord[];
  passed: number;
  passedDurations: Partial<Record<CategoryId, number[]>>;
  skipped: number;
  suiteSeconds: number;
  tests: number;
  total: number;
}

interface RawAssertion {
  message?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  passed?: boolean;
  score?: number;
  severity?: string;
}

interface FailureBody {
  assertions?: RawAssertion[];
  error?: string;
  logs?: string[];
  verdict?: string;
}

export function parseJUnitXml(xml: string): ParsedSuite {
  const suiteTag = suiteTagPattern.exec(xml);
  const suiteAttrSource = groupAt(suiteTag, 1) ?? "";
  const suiteAttrs = parseAttributes(suiteAttrSource);
  const suiteSeconds =
    Number.parseFloat(readAttr(suiteAttrs, "time", "0")) || 0;
  const cases = parseTestCases(xml);
  const passedDurations: Partial<Record<CategoryId, number[]>> = {};
  const failures: FailureRecord[] = [];
  const chatScores: ChatScore[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of cases) {
    if (item.skipped) {
      skipped += 1;
      continue;
    }
    const category = categoryFromId(item.name);
    const detail = parseFailureBody(item.failureBody ?? item.systemOutBody);
    const assertions = detail?.assertions ?? [];
    if (category === "chat") {
      chatScores.push({
        failed: item.failed,
        id: item.name,
        judge: judgeFrom(assertions),
        message:
          item.failureMessage.length > 0
            ? item.failureMessage
            : (detail?.error ?? ""),
        time: item.time,
      });
    }
    if (item.failed) {
      failed += 1;
      failures.push(toFailure(item, category));
      continue;
    }
    passed += 1;
    if (category !== "other") {
      const times = passedDurations[category] ?? [];
      times.push(item.time);
      passedDurations[category] = times;
    }
  }

  return {
    chatScores,
    failed,
    failures,
    passed,
    passedDurations,
    skipped,
    suiteSeconds,
    tests: cases.length,
    total: passed + failed,
  };
}

interface ParsedCase {
  failed: boolean;
  failureBody?: string;
  failureMessage: string;
  name: string;
  skipped: boolean;
  systemOutBody?: string;
  time: number;
}

function parseTestCases(xml: string): ParsedCase[] {
  const cases: ParsedCase[] = [];
  for (const match of xml.matchAll(testCasePattern)) {
    const selfClosingAttrs = groupAt(match, 1);
    const openAttrs = groupAt(match, 2);
    const body = groupAt(match, 3);
    const attrSource = selfClosingAttrs ?? openAttrs ?? "";
    const attrs = parseAttributes(attrSource);
    const name = readAttr(attrs, "name");
    const time = Number.parseFloat(readAttr(attrs, "time", "0")) || 0;
    if (body === undefined) {
      cases.push({
        failed: false,
        failureMessage: "",
        name,
        skipped: false,
        time,
      });
      continue;
    }
    const skipped = skippedPattern.test(body);
    const failureMatch = failurePattern.exec(body);
    const systemOutMatch = systemOutPattern.exec(body);
    cases.push({
      failed: failureMatch !== null,
      failureBody: groupAt(failureMatch, 2),
      failureMessage: unescapeXml(
        readAttr(
          parseAttributes(
            groupAt(failureMatch, 1) ?? groupAt(failureMatch, 3) ?? ""
          ),
          "message"
        )
      ),
      name,
      skipped,
      systemOutBody: groupAt(systemOutMatch, 1),
      time,
    });
  }
  return cases;
}

function toFailure(
  item: ParsedCase,
  category: CategoryId | "other"
): FailureRecord {
  const detail = parseFailureBody(item.failureBody);
  const assertions = detail?.assertions ?? [];
  const message =
    item.failureMessage.length > 0
      ? item.failureMessage
      : (detail?.error ?? "failed");
  return {
    badges: badgesFrom(assertions),
    category,
    id: item.name,
    judge: judgeFrom(assertions),
    message,
    retrieval: retrievalFrom(assertions, message),
    time: item.time,
    type: classifyFailure(message),
  };
}

export function classifyFailure(message: string): FailureType {
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("aborted")) {
    return "timeout";
  }
  if (
    message.includes("MODEL_CALL_FAILED") ||
    lower.includes("run failed") ||
    lower.includes("call failed")
  ) {
    return "call_failed";
  }
  if (lower.includes("top hit") || lower.includes("equals [top hit]")) {
    return "wrong_hit";
  }
  return "other";
}

function badgesFrom(assertions: RawAssertion[]): AssertionBadge[] {
  const badges: AssertionBadge[] = [];
  for (const assertion of assertions) {
    const name = assertion.name ?? "";
    const passed = assertion.passed === true;
    const severity: "gate" | "soft" =
      assertion.severity === "soft" ? "soft" : "gate";
    if (name === "succeeded" || name.endsWith("succeeded")) {
      badges.push({ label: "succeeded", passed, severity: "gate" });
      continue;
    }
    if (
      name.includes("calledTool") ||
      name.includes("search_journal") ||
      name.includes("searched journal")
    ) {
      badges.push({
        label: "called search_journal",
        passed,
        severity,
      });
      continue;
    }
    if (
      name.includes("judge") ||
      name.includes("factuality") ||
      name.includes("summar")
    ) {
      badges.push({
        label: name.includes("summar") ? "judge summary" : "judge factuality",
        passed,
        score: assertion.score,
        severity: "soft",
      });
    }
  }
  return badges;
}

function judgeFrom(assertions: RawAssertion[]): JudgeDetail | undefined {
  const assertion = assertions.find((item) => {
    const name = item.name ?? "";
    return (
      name.includes("judge") ||
      name.includes("factuality") ||
      name.includes("summar")
    );
  });
  if (assertion === undefined) {
    return undefined;
  }
  const metadata = assertion.metadata ?? {};
  return {
    choice: stringField(metadata, "choice"),
    expected:
      stringField(metadata, "expected") ??
      stringField(metadata, "criteria") ??
      "",
    judgeModel: stringField(metadata, "judge"),
    output: stringField(metadata, "output") ?? "",
    passed: assertion.passed === true,
    prompt: stringField(metadata, "input") ?? "",
    rationale: stringField(metadata, "rationale"),
    score: assertion.score ?? 0,
  };
}

function retrievalFrom(
  assertions: RawAssertion[],
  message: string
): RetrievalDetail | undefined {
  const assertion = assertions.find((item) => {
    const name = item.name ?? "";
    return name.includes("equals") || name.includes("top hit");
  });
  const metadata = assertion?.metadata ?? {};
  const expected =
    stringifyUnknown(metadata.expected) ?? capture(message, expectedCapture);
  const actual =
    stringifyUnknown(metadata.received ?? metadata.actual) ??
    capture(message, receivedCapture);
  if (expected === undefined || actual === undefined) {
    return undefined;
  }
  return { actual, expected };
}

function parseFailureBody(raw: string | undefined): FailureBody | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(unescapeXml(raw));
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as FailureBody;
  } catch {
    return undefined;
  }
}

function categoryFromId(id: string): CategoryId | "other" {
  const prefix = id.split("/")[0] ?? "";
  if (categorySet.has(prefix)) {
    return prefix as CategoryId;
  }
  return "other";
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(attributePattern)) {
    const key = groupAt(match, 1);
    const value = groupAt(match, 2);
    if (key !== undefined && value !== undefined) {
      attrs[key] = unescapeXml(value);
    }
  }
  return attrs;
}

function readAttr(
  attrs: Record<string, string>,
  key: string,
  fallback = ""
): string {
  for (const [name, value] of Object.entries(attrs)) {
    if (name === key) {
      return value;
    }
  }
  return fallback;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function capture(message: string, pattern: RegExp): string | undefined {
  return groupAt(pattern.exec(message), 1);
}

function groupAt(
  match: RegExpExecArray | RegExpMatchArray | null,
  index: number
): string | undefined {
  if (match === null) {
    return undefined;
  }
  const value = match.at(index);
  return typeof value === "string" ? value : undefined;
}
