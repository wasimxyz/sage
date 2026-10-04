import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assembleReport } from "./assemble.ts";
import { classifyFailure, parseJUnitXml } from "./junit.ts";

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="eve evals" tests="6" failures="3" skipped="1" time="12.500">
  <testcase classname="eve.eval" name="chat/0000" time="2.000"/>
  <testcase classname="eve.eval" name="chat/0001" time="21.360">
    <failure message="succeeded (0% &lt; 100%): run failed (code: MODEL_CALL_FAILED)">${escapeJson(
      {
        assertions: [
          {
            name: "succeeded",
            passed: false,
            score: 0,
            severity: "gate",
          },
          {
            metadata: {
              choice: "A",
              expected:
                "Yes. They reconciled and are currently together, not broken up",
              input: "Are Theo and I still together?",
              judge: "ollama/gpt-oss:20b",
              output: "",
              rationale: "The submission is empty.",
            },
            name: "judge.autoevals.factuality",
            passed: true,
            score: 0.4,
            severity: "soft",
          },
        ],
        error: "run failed (code: MODEL_CALL_FAILED)",
        verdict: "failed",
      }
    )}</failure>
  </testcase>
  <testcase classname="eve.eval" name="chat/0048" time="600.510">
    <failure message="The operation was aborted due to timeout"/>
  </testcase>
  <testcase classname="eve.eval" name="retrieval/0002" time="0.110">
    <failure message="equals [top hit] (0% &lt; 100%): expected 11; received 10">${escapeJson(
      {
        assertions: [
          {
            metadata: { expected: 11, received: 10 },
            name: "equals",
            passed: false,
            score: 0,
            severity: "gate",
          },
        ],
        verdict: "failed",
      }
    )}</failure>
  </testcase>
  <testcase classname="eve.eval" name="extraction/0000" time="8.670"/>
  <testcase classname="eve.eval" name="summaries/0000" time="0.001">
    <skipped message="No summary cases in the dataset."/>
  </testcase>
</testsuite>`;

test("parseJUnitXml counts passed and failed cases and skips skipped", () => {
  const suite = parseJUnitXml(sampleXml);
  assert.equal(suite.passed, 2);
  assert.equal(suite.failed, 3);
  assert.equal(suite.skipped, 1);
  assert.equal(suite.suiteSeconds, 12.5);
  assert.deepEqual(suite.passedDurations.chat, [2]);
  assert.deepEqual(suite.passedDurations.extraction, [8.67]);
});

test("parseJUnitXml reads judge metadata and retrieval ids from failure JSON", () => {
  const suite = parseJUnitXml(sampleXml);
  const chat = suite.failures.find((item) => item.id === "chat/0001");
  assert.equal(chat?.type, "call_failed");
  assert.equal(chat?.judge?.prompt, "Are Theo and I still together?");
  assert.equal(chat?.judge?.output, "");
  assert.equal(chat?.judge?.score, 0.4);
  const retrieval = suite.failures.find((item) => item.id === "retrieval/0002");
  assert.equal(retrieval?.type, "wrong_hit");
  assert.deepEqual(retrieval?.retrieval, { actual: "10", expected: "11" });
  const timeout = suite.failures.find((item) => item.id === "chat/0048");
  assert.equal(timeout?.type, "timeout");
});

test("classifyFailure maps eve headlines", () => {
  assert.equal(
    classifyFailure(
      "succeeded (0% < 100%): run failed (code: MODEL_CALL_FAILED)"
    ),
    "call_failed"
  );
  assert.equal(
    classifyFailure("The operation was aborted due to timeout"),
    "timeout"
  );
  assert.equal(
    classifyFailure("equals [top hit] (0% < 100%): expected 11; received 10"),
    "wrong_hit"
  );
});

test("parseJUnitXml reads judge metadata from passing system-out", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="eve evals" tests="1" failures="0" skipped="0" time="3.000">
  <testcase classname="eve.eval" name="chat/0000" time="3.000">
    <system-out>${escapeJson({
      assertions: [
        {
          name: "succeeded",
          passed: true,
          score: 1,
          severity: "gate",
        },
        {
          metadata: {
            expected: "Sam is the user's partner.",
            input: "Who is Sam?",
            judge: "ollama/qwen3:8b",
            output: "Sam is your partner.",
            rationale: "The answers match.",
          },
          name: "chat factuality",
          passed: true,
          score: 1,
          severity: "soft",
        },
      ],
      verdict: "passed",
    })}</system-out>
  </testcase>
</testsuite>`;
  const suite = parseJUnitXml(xml);
  assert.equal(suite.passed, 1);
  assert.equal(suite.failed, 0);
  assert.equal(suite.chatScores.length, 1);
  assert.equal(suite.chatScores[0]?.failed, false);
  assert.equal(suite.chatScores[0]?.judge?.prompt, "Who is Sam?");
  assert.equal(suite.chatScores[0]?.judge?.output, "Sam is your partner.");
  assert.equal(suite.chatScores[0]?.judge?.score, 1);
});

test("assembleReport matches failing prompts to fixture cases", () => {
  const report = assembleReport(
    "qwen3_14b__nomic-embed-text__20260916T061948Z",
    {
      log: `ts=1789570000000000000 level=info app="Sage" platform="macos"
ts=1789570012000000000 level=info app="Sage" platform="macos"`,
      manifest: JSON.stringify({
        cases: {
          "breakup-reconciliation": { journalIds: [1, 2, 3, 4] },
          "parent-relationship": { journalIds: [9, 10, 11, 12] },
        },
      }),
      xml: sampleXml,
    }
  );
  assert.equal(report.models.chatModel, "qwen3:14b");
  assert.equal(report.run.app, "Sage");
  assert.equal(report.run.platform, "macos");
  assert.equal(report.run.sessionSeconds, 12);
  assert.equal(report.run.infraFailed, 2);
  assert.equal(report.chatScores.length, 3);
  const scored = report.chatScores.find((item) => item.id === "chat/0001");
  assert.equal(scored?.judge?.prompt, "Are Theo and I still together?");
  const breakup = report.scenarios.find(
    (item) => item.id === "breakup-reconciliation"
  );
  assert.deepEqual(breakup?.matchedPrompts, ["Are Theo and I still together?"]);
  const parent = report.scenarios.find(
    (item) => item.id === "parent-relationship"
  );
  assert.equal(parent?.entries, 4);
  assert.ok(parent?.matchedPrompts.length === 0);
});

const blobSampleId = "qwen3_14b__nomic-embed-text__20260916T061948Z";
const blobSampleDir = join(import.meta.dirname, "samples");
const blobSampleXml =
  process.env.SAGE_EVAL_14B_XML ?? join(blobSampleDir, `${blobSampleId}.xml`);

test("parseJUnitXml reads the 14b blob sample when present", {
  skip: !existsSync(blobSampleXml),
}, () => {
  const xml = readFileSync(blobSampleXml, "utf8");
  const suite = parseJUnitXml(xml);
  assert.ok(suite.total > 0);
  assert.equal(suite.passed + suite.failed, suite.total);
  assert.ok(suite.failures.every((item) => item.id.length > 0));
  const logPath = join(blobSampleDir, `${blobSampleId}.sage.log`);
  const manifestPath = join(blobSampleDir, `${blobSampleId}.manifest.json`);
  const report = assembleReport(blobSampleId, {
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : undefined,
    manifest: existsSync(manifestPath)
      ? readFileSync(manifestPath, "utf8")
      : undefined,
    xml,
  });
  assert.equal(report.models.dreamModel, "qwen3:14b");
  assert.equal(report.models.embedModel, "nomic-embed-text");
  assert.equal(report.models.chatModel, "qwen3:14b");
  assert.equal(report.run.total, suite.total);
  assert.equal(report.categories.length, 4);
});

function escapeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
