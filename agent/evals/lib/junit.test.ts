import assert from "node:assert/strict";
import test from "node:test";

import { mergeJunit } from "./junit.ts";
import type { RecordedEvalResult } from "./recorder.ts";

const tests0Pattern = /tests="0"/;
const tests5Pattern = /tests="5"/;
const failures1Pattern = /failures="1"/;
const skipped1Pattern = /skipped="1"/;
const time7750Pattern = /time="7.750"/;
const nameChat0000Pattern = /name="chat\/0000"/;
const nameChat0001Pattern = /name="chat\/0001"/;
const nameChatJudge0000Pattern = /name="chat-judge\/0000"/;
const nameExtraction0000Pattern = /name="extraction\/0000"/;
const nameRetrieval0000Pattern = /name="retrieval\/0000"/;
const runFailedPattern = /run failed/;
const noRetrievalCasesInTheDatasetPattern = /No retrieval cases in the dataset/;
const tests2Pattern = /tests="2"/;
const failures0Pattern = /failures="0"/;
const skipped0Pattern = /skipped="0"/;
const nameChatJudgePattern = /name="chat-judge\//;
const missingATestsuitePattern = /missing a testsuite/;
const tests4Pattern = /tests="4"/;
const systemOutPattern = /<system-out>/;
const whoIsSamPattern = /Who is Sam\?/;
const samIsYourPartnerPattern = /Sam is your partner\./;
const failureMessageRunFailedPattern = /<failure message="run failed">/;
const areTheoAndIStillTogetherPattern = /Are Theo and I still together\?/;
const time3000Pattern = /time="3.000"/;
const chatFactualityOrderPattern =
  /name="chat\/0000"[\s\S]*chat factuality[\s\S]*name="chat\/0001"/;
const chatTheoOrderPattern =
  /name="chat\/0001"[\s\S]*Are Theo and I still together\?/;
const chatFactualityPattern = /chat factuality/;
const time0000Pattern = /time="0.000"/;

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
  assert.match(merged, tests5Pattern);
  assert.match(merged, failures1Pattern);
  assert.match(merged, skipped1Pattern);
  assert.match(merged, time7750Pattern);
  assert.match(merged, nameChat0000Pattern);
  assert.match(merged, nameChat0001Pattern);
  assert.match(merged, nameChatJudge0000Pattern);
  assert.match(merged, nameExtraction0000Pattern);
  assert.match(merged, nameRetrieval0000Pattern);
  assert.match(merged, runFailedPattern);
  assert.match(merged, noRetrievalCasesInTheDatasetPattern);
});

test("mergeJunit treats a missing or empty file as an empty suite", () => {
  const fromEmpty = mergeJunit("", generateXml);
  assert.match(fromEmpty, tests2Pattern);
  assert.match(fromEmpty, nameChat0000Pattern);
  const bothEmpty = mergeJunit("", "");
  assert.match(bothEmpty, tests0Pattern);
  assert.match(bothEmpty, failures0Pattern);
  assert.match(bothEmpty, skipped0Pattern);
  assert.match(bothEmpty, time0000Pattern);
});

test("mergeJunit throws when the XML has no testsuite", () => {
  assert.throws(
    () => mergeJunit("<ok/>", generateXml),
    missingATestsuitePattern
  );
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
  assert.match(merged, tests4Pattern);
  assert.match(merged, failures1Pattern);
  assert.match(merged, skipped1Pattern);
  assert.doesNotMatch(merged, nameChatJudgePattern);
  assert.match(merged, nameExtraction0000Pattern);
  assert.match(merged, systemOutPattern);
  assert.match(merged, whoIsSamPattern);
  assert.match(merged, samIsYourPartnerPattern);
  assert.match(merged, failureMessageRunFailedPattern);
  assert.match(merged, areTheoAndIStillTogetherPattern);
  assert.match(merged, time3000Pattern);
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
  assert.doesNotMatch(merged, chatFactualityOrderPattern);
  assert.match(merged, chatTheoOrderPattern);
  assert.match(merged, nameChat0000Pattern);
});

test("mergeJunit keeps a chat case when the judge row is missing", () => {
  const merged = mergeJunit(generateXml, judgeXml, [
    sampleChat({
      id: "chat/0000",
      metadata: { caseId: "sam-example", index: 0, question: "Who is Sam?" },
      verdict: "passed",
    }),
  ]);
  assert.match(merged, nameChat0000Pattern);
  assert.match(merged, systemOutPattern);
  assert.doesNotMatch(merged, chatFactualityPattern);
  assert.doesNotMatch(merged, nameChatJudgePattern);
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
