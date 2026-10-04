import assert from "node:assert/strict";
import test from "node:test";

import { mergeJunit } from "./junit.ts";
import type { RecordedEvalResult } from "./recorder.ts";

const generateXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="eve evals" tests="2" failures="1" skipped="0" time="3.250">
  <testcase classname="eve.eval" name="chat/0000" time="1.000"/>
  <testcase classname="eve.eval" name="chat/0001" time="2.250">
    <failure message="succeeded (0% &lt; 100%): run failed">{"verdict":"failed"}</failure>
  </testcase>
</testsuite>
`;

const judgeXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="eve evals" tests="3" failures="0" skipped="1" time="4.500">
  <testcase classname="eve.eval" name="chat-judge/0000" time="2.000"/>
  <testcase classname="eve.eval" name="extraction/0000" time="2.500"/>
  <testcase classname="eve.eval" name="retrieval/0000" time="0.001">
    <skipped message="No retrieval cases in the dataset."/>
  </testcase>
</testsuite>
`;

test("mergeJunit concatenates test cases and sums suite counts", () => {
  const merged = mergeJunit(generateXml, judgeXml);
  assert.match(merged, /tests="5"/);
  assert.match(merged, /failures="1"/);
  assert.match(merged, /skipped="1"/);
  assert.match(merged, /time="7.750"/);
  assert.match(merged, /name="chat\/0000"/);
  assert.match(merged, /name="chat\/0001"/);
  assert.match(merged, /name="chat-judge\/0000"/);
  assert.match(merged, /name="extraction\/0000"/);
  assert.match(merged, /name="retrieval\/0000"/);
  assert.match(merged, /run failed/);
  assert.match(merged, /No retrieval cases in the dataset/);
});

test("mergeJunit treats a missing or empty file as an empty suite", () => {
  const fromEmpty = mergeJunit("", generateXml);
  assert.match(fromEmpty, /tests="2"/);
  assert.match(fromEmpty, /name="chat\/0000"/);
  const bothEmpty = mergeJunit("", "");
  assert.match(bothEmpty, /tests="0"/);
  assert.match(bothEmpty, /failures="0"/);
  assert.match(bothEmpty, /skipped="0"/);
  assert.match(bothEmpty, /time="0.000"/);
});

test("mergeJunit throws when the XML has no testsuite", () => {
  assert.throws(() => mergeJunit("<ok/>", generateXml), /missing a testsuite/);
});

test("mergeJunit stitches chat and chat-judge by caseId and index", () => {
  const merged = mergeJunit(generateXml, judgeXml, [
    sampleChat({
      completedAt: "2026-09-16T22:00:01.000Z",
      id: "chat/0000",
      metadata: {
        caseId: "sam-example",
        index: 0,
        question: "Who is Sam?",
        reference: "Sam is the user's partner.",
      },
      startedAt: "2026-09-16T22:00:00.000Z",
      verdict: "passed",
    }),
    sampleChat({
      assertions: [
        {
          name: "succeeded",
          passed: false,
          score: 0,
          severity: "gate",
        },
      ],
      completedAt: "2026-09-16T22:00:04.250Z",
      error: "run failed",
      id: "chat/0001",
      metadata: {
        caseId: "breakup-reconciliation",
        index: 0,
        question: "Are Theo and I still together?",
        reference: "Yes. They reconciled.",
      },
      startedAt: "2026-09-16T22:00:02.000Z",
      verdict: "failed",
    }),
    sampleChat({
      assertions: [
        {
          metadata: {
            expected: "Sam is the user's partner.",
            output: "Sam is your partner.",
          },
          name: "chat factuality",
          passed: true,
          score: 1,
          severity: "soft",
        },
      ],
      completedAt: "2026-09-16T22:00:03.000Z",
      id: "chat-judge/0000",
      metadata: {
        caseId: "sam-example",
        index: 0,
        question: "Who is Sam?",
        reference: "Sam is the user's partner.",
        reply: "Sam is your partner.",
      },
      startedAt: "2026-09-16T22:00:01.000Z",
      verdict: "passed",
    }),
    sampleChat({
      assertions: [
        {
          metadata: {
            expected: "Yes. They reconciled.",
            output: "",
          },
          name: "chat factuality",
          passed: true,
          score: 0.4,
          severity: "soft",
        },
      ],
      completedAt: "2026-09-16T22:00:05.000Z",
      id: "chat-judge/0001",
      metadata: {
        caseId: "breakup-reconciliation",
        index: 0,
        question: "Are Theo and I still together?",
        reference: "Yes. They reconciled.",
        reply: "",
      },
      startedAt: "2026-09-16T22:00:04.000Z",
      verdict: "passed",
    }),
  ]);
  assert.match(merged, /tests="4"/);
  assert.match(merged, /failures="1"/);
  assert.match(merged, /skipped="1"/);
  assert.doesNotMatch(merged, /name="chat-judge\//);
  assert.match(merged, /name="extraction\/0000"/);
  assert.match(merged, /<system-out>/);
  assert.match(merged, /Who is Sam\?/);
  assert.match(merged, /Sam is your partner\./);
  assert.match(merged, /<failure message="run failed">/);
  assert.match(merged, /Are Theo and I still together\?/);
  assert.match(merged, /time="3.000"/);
});

test("mergeJunit pairs by caseId and index when judge ids shift", () => {
  const merged = mergeJunit(generateXml, judgeXml, [
    sampleChat({
      id: "chat/0000",
      metadata: { caseId: "sam-example", index: 0, question: "Who is Sam?" },
      verdict: "failed",
    }),
    sampleChat({
      id: "chat/0001",
      metadata: {
        caseId: "breakup-reconciliation",
        index: 0,
        question: "Are Theo and I still together?",
      },
      verdict: "passed",
    }),
    sampleChat({
      assertions: [
        {
          metadata: { output: "They are together." },
          name: "chat factuality",
          passed: true,
          score: 0.6,
          severity: "soft",
        },
      ],
      id: "chat-judge/0000",
      metadata: {
        caseId: "breakup-reconciliation",
        index: 0,
        question: "Are Theo and I still together?",
        reply: "They are together.",
      },
      verdict: "passed",
    }),
  ]);
  assert.doesNotMatch(
    merged,
    /name="chat\/0000"[\s\S]*chat factuality[\s\S]*name="chat\/0001"/
  );
  assert.match(
    merged,
    /name="chat\/0001"[\s\S]*Are Theo and I still together\?/
  );
  assert.match(merged, /name="chat\/0000"/);
});

test("mergeJunit keeps a chat case when the judge row is missing", () => {
  const merged = mergeJunit(generateXml, judgeXml, [
    sampleChat({
      id: "chat/0000",
      metadata: { caseId: "sam-example", index: 0, question: "Who is Sam?" },
      verdict: "passed",
    }),
  ]);
  assert.match(merged, /name="chat\/0000"/);
  assert.match(merged, /<system-out>/);
  assert.doesNotMatch(merged, /chat factuality/);
  assert.doesNotMatch(merged, /name="chat-judge\//);
});

function sampleChat(
  overrides: Partial<RecordedEvalResult> = {}
): RecordedEvalResult {
  return {
    assertions: [
      {
        name: "succeeded",
        passed: true,
        score: 1,
        severity: "gate",
      },
    ],
    completedAt: "2026-09-16T22:00:01.000Z",
    id: "chat/0000",
    metadata: {},
    startedAt: "2026-09-16T22:00:00.000Z",
    verdict: "passed",
    ...overrides,
  };
}
