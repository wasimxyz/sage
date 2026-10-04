import type {
  RecordedAssertion,
  RecordedEvalResult,
} from "./recorder.ts";

const suiteTagPattern = /<testsuite\b([^>]*)>/;
const testCasePattern =
  /<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g;
const attributePattern = /(\w+)="([^"]*)"/g;
const caseNamePattern = /\bname="([^"]*)"/;

interface Suite {
  cases: string[];
  failures: number;
  name: string;
  skipped: number;
  tests: number;
  time: number;
}

export function mergeJunit(
  left: string,
  right: string,
  results: RecordedEvalResult[] = []
): string {
  const first = parseSuite(left) ?? emptySuite();
  const second = parseSuite(right) ?? emptySuite();
  if (results.length === 0) {
    return renderSuite({
      cases: [...first.cases, ...second.cases],
      failures: first.failures + second.failures,
      name: first.name || second.name || "eve evals",
      skipped: first.skipped + second.skipped,
      tests: first.tests + second.tests,
      time: first.time + second.time,
    });
  }
  const otherCases = [...first.cases, ...second.cases].filter((xml) => {
    const name = caseName(xml);
    return !isChatGenerateId(name) && !isChatJudgeId(name);
  });
  const cases = [...buildChatCases(results), ...otherCases];
  return renderSuite(recount(cases, first.name || second.name || "eve evals"));
}

function buildChatCases(results: RecordedEvalResult[]): string[] {
  const judges = new Map<string, RecordedEvalResult>();
  for (const row of results) {
    if (!isChatJudgeId(row.id)) {
      continue;
    }
    const key = pairKey(row.metadata);
    if (key !== undefined) {
      judges.set(key, row);
    }
  }
  return results
    .filter((row) => isChatGenerateId(row.id))
    .map((chat) => {
      const key = pairKey(chat.metadata);
      const judge = key === undefined ? undefined : judges.get(key);
      return renderChatCase(chat, judge);
    });
}

function renderChatCase(
  chat: RecordedEvalResult,
  judge: RecordedEvalResult | undefined
): string {
  const assertions = attachJudgeAssertions(chat, judge);
  const time = durationSeconds(chat) + (judge === undefined ? 0 : durationSeconds(judge));
  const attrs = `classname="eve.eval" name="${escapeXml(chat.id)}" time="${formatSeconds(time)}"`;
  if (chat.verdict === "skipped") {
    return [
      `  <testcase ${attrs}>`,
      `    <skipped message="${escapeXml(chat.skipReason ?? "skipped")}"/>`,
      `  </testcase>`,
    ].join("\n");
  }
  const detail = {
    assertions,
    error: chat.error,
    verdict: chat.verdict,
  };
  const json = escapeXml(JSON.stringify(detail));
  if (chat.verdict === "failed") {
    return [
      `  <testcase ${attrs}>`,
      `    <failure message="${escapeXml(failureMessage(chat, assertions))}">${json}</failure>`,
      `  </testcase>`,
    ].join("\n");
  }
  return [
    `  <testcase ${attrs}>`,
    `    <system-out>${json}</system-out>`,
    `  </testcase>`,
  ].join("\n");
}

function attachJudgeAssertions(
  chat: RecordedEvalResult,
  judge: RecordedEvalResult | undefined
): RecordedAssertion[] {
  if (judge === undefined) {
    return chat.assertions;
  }
  const question =
    stringField(chat.metadata, "question") ??
    stringField(judge.metadata, "question") ??
    "";
  const reply = stringField(judge.metadata, "reply") ?? "";
  const rewritten = judge.assertions.map((assertion) => {
    if (!isFactuality(assertion.name)) {
      return assertion;
    }
    const metadata = { ...(assertion.metadata ?? {}) };
    metadata.input = question;
    const output = metadata.output;
    if (typeof output !== "string" || output.length === 0) {
      metadata.output = reply;
    }
    return { ...assertion, metadata };
  });
  return [...chat.assertions, ...rewritten];
}

function isFactuality(name: string): boolean {
  return name.includes("factuality") || name.includes("judge");
}

function failureMessage(
  chat: RecordedEvalResult,
  assertions: RecordedAssertion[]
): string {
  if (chat.error !== undefined && chat.error.length > 0) {
    return chat.error;
  }
  const failed = assertions.find((assertion) => !assertion.passed);
  if (failed?.message !== undefined && failed.message.length > 0) {
    return failed.message;
  }
  if (failed !== undefined) {
    return failed.name;
  }
  return chat.verdict;
}

function pairKey(metadata: Record<string, unknown>): string | undefined {
  const caseId = metadata.caseId;
  const index = metadata.index;
  if (typeof caseId !== "string" || caseId.length === 0) {
    return undefined;
  }
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return undefined;
  }
  return `${caseId}:${index}`;
}

function stringField(
  metadata: Record<string, unknown>,
  key: string
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function durationSeconds(row: RecordedEvalResult): number {
  const started = Date.parse(row.startedAt);
  const completed = Date.parse(row.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return 0;
  }
  return Math.max(0, (completed - started) / 1000);
}

function isChatGenerateId(id: string): boolean {
  return id.startsWith("chat/");
}

function isChatJudgeId(id: string): boolean {
  return id.startsWith("chat-judge/");
}

function caseName(xml: string): string {
  const match = caseNamePattern.exec(xml);
  return match?.[1] ?? "";
}

function recount(cases: string[], name: string): Suite {
  let failures = 0;
  let skipped = 0;
  let time = 0;
  for (const xml of cases) {
    if (xml.includes("<failure")) {
      failures += 1;
    }
    if (xml.includes("<skipped")) {
      skipped += 1;
    }
    const attrs = parseAttributes(xml);
    time += readNumber(attrs, "time");
  }
  return {
    cases,
    failures,
    name,
    skipped,
    tests: cases.length,
    time,
  };
}

function parseSuite(xml: string): Suite | undefined {
  const trimmed = xml.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const suiteTag = suiteTagPattern.exec(trimmed);
  if (suiteTag === null) {
    throw new Error("JUnit XML is missing a testsuite element.");
  }
  const attrs = parseAttributes(suiteTag[1] ?? "");
  const cases = trimmed.match(testCasePattern) ?? [];
  return {
    cases,
    failures: readNumber(attrs, "failures"),
    name: attrs.name ?? "eve evals",
    skipped: readNumber(attrs, "skipped"),
    tests: readNumber(attrs, "tests"),
    time: readNumber(attrs, "time"),
  };
}

function emptySuite(): Suite {
  return {
    cases: [],
    failures: 0,
    name: "eve evals",
    skipped: 0,
    tests: 0,
    time: 0,
  };
}

function renderSuite(suite: Suite): string {
  const cases =
    suite.cases.length === 0 ? "" : `\n${suite.cases.join("\n")}\n`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="${escapeXml(suite.name)}" tests="${suite.tests}" failures="${suite.failures}" skipped="${suite.skipped}" time="${formatSeconds(suite.time)}">${cases}</testsuite>`,
    "",
  ].join("\n");
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  attributePattern.lastIndex = 0;
  let match = attributePattern.exec(source);
  while (match !== null) {
    attrs[match[1] ?? ""] = match[2] ?? "";
    match = attributePattern.exec(source);
  }
  return attrs;
}

function readNumber(attrs: Record<string, string>, key: string): number {
  const raw = attrs[key];
  if (raw === undefined || raw.length === 0) {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
