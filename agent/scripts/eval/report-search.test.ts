// What the report says about searches, slips, and tools.

import assert from "node:assert/strict";
import test from "node:test";

import type { RecordedAssertion } from "../../evals/lib/recorder.ts";
import {
  parseSetupReport,
  parseSweepFile,
  parseTranscriptRow,
  type Setup,
  setupId as setupIdOf,
  type TranscriptRow,
} from "../../evals/lib/schema.ts";
import type { PassName } from "./plan.ts";
import {
  assembleSetupReport,
  type PassRow,
  summarizeToolUse,
} from "./report.ts";

const setup: Setup = {
  chatModel: "qwen3.5:9b",
  contextLength: 32_768,
  dreamPrompt: "baseline",
  embedModel: "nomic-embed-text",
  memory: "off",
  prompt: "baseline",
  summaryModel: "qwen3.5:9b",
  thinking: "off",
};
const id = setupIdOf(setup);
const sweep = parseSweepFile({});

function check(
  tier: string,
  checkId: string,
  passed: boolean,
  turnIndex = 1
): RecordedAssertion {
  return {
    metadata: { checkId, tier, turnIndex },
    name: `${tier}:${checkId}`,
    passed,
    score: passed ? 1 : 0,
    severity: "soft",
  };
}

function gradeRow(itemId: string, assertions: RecordedAssertion[]): PassRow {
  return {
    pass: "grade" as PassName,
    row: {
      assertions,
      completedAt: "2026-11-10T03:00:01.000Z",
      id: itemId,
      metadata: {
        itemId,
        kind: "opener",
        person: "sam",
        repeat: 1,
        setupId: id,
      },
      startedAt: "2026-11-10T03:00:00.000Z",
      verdict: "passed",
    },
  };
}

function call(name: string, query = "rent") {
  return {
    input: { query },
    name,
    output: {},
    status: "completed" as const,
  };
}

function transcriptRow(
  itemId: string,
  toolCalls: ReturnType<typeof call>[],
  toolMs: number
): TranscriptRow {
  return parseTranscriptRow({
    ended: "done",
    itemId,
    journal: "own",
    kind: "opener",
    person: "sam",
    repeat: 1,
    setupId: id,
    turns: [
      { role: "user", text: "How was my week?" },
      {
        role: "assistant",
        text: "You wrote about the market.",
        timing: { firstVisibleMs: 1000, toolMs, totalMs: 4000 },
        toolCalls,
      },
    ],
  });
}

function assemble(
  rows: PassRow[],
  transcripts: TranscriptRow[],
  memory: "off" | "on" = "off"
) {
  return assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows,
    setup: { ...setup, memory },
    sweep,
    sweepId: "2026-11-10T031500Z-quick",
    transcripts,
  });
}

test("slips and search metrics are counted over the graded replies, as a count and a rate, and never fail the setup", () => {
  const report = assemble(
    [
      gradeRow("sam/opener/a", [
        check("slip", "shows-internals", false),
        check("slip", "many-questions", true),
        check("search", "missed-search", false),
        check("search", "found-needed", true),
        check("counted", "no-runaway-search", true),
      ]),
      gradeRow("sam/opener/b", [
        check("slip", "shows-internals", true),
        check("slip", "many-questions", true),
        check("search", "missed-search", true),
        check("counted", "no-runaway-search", false),
      ]),
    ],
    [transcriptRow("sam/opener/a", [], 0), transcriptRow("sam/opener/b", [], 0)]
  );
  const soft = Object.fromEntries(
    report.summary.softByCheck.map((entry) => [entry.id, entry])
  );
  assert.deepEqual(soft["shows-internals"], {
    failures: 1,
    graded: 2,
    id: "shows-internals",
    rate: 0.5,
  });
  assert.equal(soft["many-questions"]?.failures, 0);
  assert.equal(soft["missed-search"]?.rate, 0.5);
  assert.equal(soft["found-needed"]?.graded, 1);
  // The runaway check is counted, so it is in the counted list and not the soft one.
  assert.equal(soft["no-runaway-search"], undefined);
  const counted = report.summary.countedByCheck.find(
    (entry) => entry.id === "no-runaway-search"
  );
  assert.deepEqual(counted, {
    failures: 1,
    graded: 2,
    id: "no-runaway-search",
    rate: 0.5,
  });
  assert.deepEqual(report.summary.hardFailures, []);
  assert.equal(report.summary.countedFailures, 1, "slips do not add to it");
  // The ids sort, so the report does not change order between runs.
  assert.deepEqual(
    report.summary.softByCheck.map((entry) => entry.id),
    [...report.summary.softByCheck.map((entry) => entry.id)].sort()
  );
  parseSetupReport(JSON.parse(JSON.stringify(report)), "round trip");
});

test("a slip that did not apply, or was not graded, is left out of its rate", () => {
  const skipped: RecordedAssertion = {
    metadata: {
      checkId: "formatting",
      notApplicable: true,
      tier: "slip",
      turnIndex: 1,
    },
    name: "slip:formatting",
    score: 0,
    severity: "soft",
  };
  const report = assemble(
    [
      gradeRow("sam/opener/a", [
        skipped,
        check("slip", "many-questions", true),
      ]),
    ],
    [transcriptRow("sam/opener/a", [], 0)]
  );
  assert.deepEqual(
    report.summary.softByCheck.map((entry) => entry.id),
    ["many-questions"]
  );
});

test("tool use counts searches, reads, tool calls, and the time in tools over the assistant turns", () => {
  const report = assemble(
    [gradeRow("sam/opener/a", [check("slip", "many-questions", true)])],
    [
      transcriptRow(
        "sam/opener/a",
        [
          call("search_journal"),
          call("search_chats", "dad"),
          call("get_journal_entry", "entry-1"),
        ],
        2500
      ),
      transcriptRow("sam/opener/b", [call("search_journal")], 500),
      transcriptRow("sam/opener/c", [], 0),
    ]
  );
  assert.deepEqual(report.summary.toolUse, {
    reads: 0,
    searches: 3,
    toolCalls: 4,
    toolMs: 3000,
    turns: 3,
  });
});

test("tool use leaves out the memory tool when memory is off, and counts it when memory is on", () => {
  const rows = [
    transcriptRow(
      "sam/opener/a",
      [call("facts__search_memories"), call("search_journal")],
      100
    ),
  ];
  assert.deepEqual(summarizeToolUse(rows, false), {
    reads: 0,
    searches: 1,
    toolCalls: 1,
    toolMs: 100,
    turns: 1,
  });
  assert.deepEqual(summarizeToolUse(rows, true), {
    reads: 0,
    searches: 2,
    toolCalls: 2,
    toolMs: 100,
    turns: 1,
  });
  const off = assemble([], rows, "off");
  const on = assemble([], rows, "on");
  assert.equal(off.summary.toolUse.searches, 1);
  assert.equal(on.summary.toolUse.searches, 2);
});

test("a report with no transcripts has empty search figures, and an older report still parses", () => {
  const report = assemble([], []);
  assert.deepEqual(report.summary.softByCheck, []);
  assert.deepEqual(report.summary.toolUse, {
    reads: 0,
    searches: 0,
    toolCalls: 0,
    toolMs: 0,
    turns: 0,
  });
  const {
    softByCheck: _soft,
    toolUse: _use,
    ...older
  } = JSON.parse(JSON.stringify(report.summary));
  const parsed = parseSetupReport(
    { ...JSON.parse(JSON.stringify(report)), summary: older },
    "an older report"
  );
  assert.deepEqual(parsed.summary.softByCheck, []);
  assert.equal(parsed.summary.toolUse.turns, 0);
});
