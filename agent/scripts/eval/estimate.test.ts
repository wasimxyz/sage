import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  expandSetups,
  parseSetupReport,
  parseSweepFile,
  parseTranscriptRow,
  reportFileName,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import {
  dreamMissKey,
  ESTIMATE_DEFAULTS,
  estimateRun,
  formatEstimate,
  historyKey,
  loadTimingHistory,
  secondsPerReply,
} from "./estimate.ts";
import { buildPlan } from "./plan.ts";
import { assembleSetupReport } from "./report.ts";
import { makePerson, tempDir } from "./test-fixtures.ts";

const pattern1 = /simulated user/u;

const prices = {
  judge: { inputPerM: 2, outputPerM: 10 },
  simulatedUser: { inputPerM: 0.1, outputPerM: 0.5 },
};

function inputFor(
  sweepFields: Record<string, unknown>,
  people = [makePerson("sam", { chat: [{ question: "q", reference: "r" }] })],
  extra: { dreamMisses?: Set<string>; history?: Map<string, number> } = {}
) {
  const sweep = parseSweepFile(sweepFields);
  const setups = expandSetups(sweep);
  const plan = buildPlan(setups, people, sweep);
  return {
    dreamMisses: extra.dreamMisses ?? new Set<string>(),
    history: extra.history ?? new Map<string, number>(),
    plan,
    prices,
    sweep,
  };
}

test("an empty plan still pays for the build and the grading tail", () => {
  const estimate = estimateRun(inputFor({ tests: ["facts"] }, []));
  const fixed =
    ESTIMATE_DEFAULTS.buildMinutes * 60 +
    ESTIMATE_DEFAULTS.gradeTailMinutes * 60;
  assert.ok(Math.abs(estimate.hours - fixed / 3600) < 1e-9);
  assert.equal(estimate.costUsd, 0);
  assert.equal(estimate.dreamMissCount, 0);
});

test("Dream time comes from the entries the cache cannot answer", () => {
  const people = [
    makePerson("sam", { entries: 10 }),
    makePerson("kim", { entries: 0 }),
  ];
  const withoutMisses = estimateRun(inputFor({ memory: ["on"] }, people));
  const input = inputFor({ memory: ["on"] }, people);
  const [group] = input.plan.groups;
  const misses = new Set([
    dreamMissKey(group?.dreamKeyId ?? "", "sam"),
    // An empty journal never runs Dream, whatever the cache says.
    dreamMissKey(group?.dreamKeyId ?? "", "kim"),
  ]);
  const withMiss = estimateRun({ ...input, dreamMisses: misses });
  assert.equal(withMiss.dreamMissCount, 1);
  const addedHours = (10 * ESTIMATE_DEFAULTS.dreamSecondsPerEntry.on) / 3600;
  assert.ok(Math.abs(withMiss.hours - withoutMisses.hours - addedHours) < 1e-9);
  const off = inputFor({ memory: ["off"] }, people);
  const offMiss = estimateRun({
    ...off,
    dreamMisses: new Set([
      dreamMissKey(off.plan.groups[0]?.dreamKeyId ?? "", "sam"),
    ]),
  });
  assert.ok(offMiss.hours < withMiss.hours, "memory-off Dream is shorter");
});

test("reply time uses the last report for the chat model, else the default", () => {
  const defaulted = estimateRun(inputFor({ tests: ["facts"] }));
  const fast = estimateRun(
    inputFor({ tests: ["facts"] }, undefined, {
      history: new Map([[historyKey("qwen3.5:9b", "off"), 5]]),
    })
  );
  const slow = estimateRun(
    inputFor({ tests: ["facts"] }, undefined, {
      history: new Map([[historyKey("qwen3.5:9b", "off"), 125]]),
    })
  );
  // One reply a person: the difference is the difference in seconds per reply.
  assert.ok(
    Math.abs(slow.hours - fast.hours - 120 / 3600) < 1e-9,
    "each reply costs its measured time"
  );
  assert.ok(
    Math.abs(
      defaulted.hours -
        fast.hours -
        (ESTIMATE_DEFAULTS.replySeconds.off - 5) / 3600
    ) < 1e-9
  );
});

test("replies are judged, and conversation turns also call the simulated user", () => {
  const chatOnly = estimateRun(inputFor({ tests: ["facts"] }));
  assert.ok(chatOnly.costUsd > 0);
  const noJudgedTests = estimateRun(
    inputFor({ tests: ["person"] }, [makePerson("sam")])
  );
  assert.equal(noJudgedTests.costUsd, 0);
  const talking = estimateRun(
    inputFor({ tests: ["conversations"] }, [
      makePerson("sam", {
        conversations: [
          {
            expect: "venting",
            id: "c",
            maxTurns: 8,
            opening: "Hi.",
            persona: {
              openness: "open",
              situation: "x",
              style: "terse",
              wants: "vent",
            },
          },
        ],
      }),
    ])
  );
  assert.match(talking.lines.join("\n"), pattern1);
  assert.ok(talking.costUsd > 0);
});

test("repeats multiply the replies", () => {
  const once = estimateRun(inputFor({ repeats: 1, tests: ["facts"] }));
  const thrice = estimateRun(inputFor({ repeats: 3, tests: ["facts"] }));
  assert.ok(thrice.costUsd > once.costUsd * 2.9);
  assert.ok(thrice.hours > once.hours);
});

test("formatEstimate shows the totals, default prices, and a spending-cap warning", () => {
  const estimate = {
    costUsd: 75,
    dreamMissCount: 2,
    hours: 8.04,
    lines: ["Dream: 2 runs"],
  };
  const lines = formatEstimate(estimate, {
    capUsd: 50,
    defaultedPrices: ["moonshotai/kimi-k3.1-pro"],
  });
  assert.equal(lines[0], "Estimate: about 8.0 hours and $75.00");
  assert.ok(lines.some((line) => line.includes("Dream: 2 runs")));
  assert.ok(lines.some((line) => line.includes("default prices")));
  assert.ok(lines.some((line) => line.includes("over the $50 spending cap")));
  const calm = formatEstimate(
    { ...estimate, costUsd: 5 },
    { capUsd: 50, defaultedPrices: [] }
  );
  assert.ok(!calm.some((line) => line.includes("spending cap")));
  assert.ok(calm.some((line) => line.includes("Filters passed in ARGS")));
});

function timedReport(chatModel: string, totalMs: number[]) {
  const setup = {
    chatModel,
    contextLength: 32_768,
    dreamPrompt: "baseline",
    embedModel: "nomic-embed-text",
    memory: "off" as const,
    prompt: "baseline",
    summaryModel: "qwen3.5:9b",
    thinking: "off" as const,
  };
  const id = setupIdOf(setup);
  const transcripts = totalMs.map((ms, index) =>
    parseTranscriptRow({
      ended: "done",
      itemId: `sam/chat/${index + 1}`,
      journal: "own",
      kind: "chat",
      person: "sam",
      repeat: 1,
      setupId: id,
      turns: [
        { role: "user", text: "hi" },
        {
          role: "assistant",
          text: "hello",
          timing: { firstVisibleMs: 1000, toolMs: 0, totalMs: ms },
        },
      ],
    })
  );
  return assembleSetupReport({
    gitCommit: "abc",
    people: ["sam"],
    promptShas: { chat: "x", dream: null },
    rows: [],
    setup,
    sweep: parseSweepFile({}),
    sweepId: "2026-11-10T031500Z-smoke",
    transcripts,
  });
}

test("secondsPerReply is the mean total wait of the assistant turns", () => {
  const report = timedReport("qwen3.5:9b", [10_000, 20_000, 30_000]);
  assert.equal(secondsPerReply(report), 20);
  assert.equal(secondsPerReply(timedReport("qwen3.5:9b", [])), null);
});

test("the timing history takes the newest report for each chat model", (t) => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const old = timedReport("qwen3.5:9b", [60_000]);
  const recent = {
    ...timedReport("qwen3.5:9b", [10_000]),
    sweepId: "2026-11-11T031500Z-smoke",
  };
  const other = timedReport("gpt-oss:20b", [40_000]);
  const files: [string, unknown, number][] = [
    [reportFileName(old.sweepId, old.setupId), old, 1000],
    [reportFileName(recent.sweepId, recent.setupId), recent, 2000],
    [reportFileName(other.sweepId, other.setupId), other, 1500],
  ];
  for (const [name, report, seconds] of files) {
    writeFileSync(join(dir, name), JSON.stringify(report));
    utimesSync(join(dir, name), seconds, seconds);
  }
  writeFileSync(join(dir, "broken.report.json"), "{not json");
  writeFileSync(join(dir, "old-run.xml"), "<testsuite/>");
  const history = loadTimingHistory(dir);
  assert.equal(history.get(historyKey("qwen3.5:9b", "off")), 10);
  assert.equal(history.get(historyKey("gpt-oss:20b", "off")), 40);
  assert.equal(history.size, 2);
  assert.deepEqual(parseSetupReport(JSON.parse(JSON.stringify(old))), old);
});

test("a folder with no reports gives an empty history", (t) => {
  assert.equal(loadTimingHistory(join(tempDir(t), "missing")).size, 0);
  assert.equal(loadTimingHistory(tempDir(t)).size, 0);
});
