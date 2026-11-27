import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadPeople } from "../../evals/lib/dataset.ts";
import { costUsd } from "../../evals/lib/prices.ts";
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
  ESTIMATE_TOKENS,
  estimateRun,
  formatEstimate,
  historyKey,
  loadTimingHistory,
  secondsPerReply,
} from "./estimate.ts";
import { judgeCheckSize } from "./judge-check.ts";
import { selectPeople } from "./people.ts";
import { buildPlan } from "./plan.ts";
import { assembleSetupReport } from "./report.ts";
import { loadSweep } from "./sweep.ts";
import { conversation, makePerson, tempDir } from "./test-fixtures.ts";

const pattern1 = /simulated user/u;
const judgeCheck41Pattern = /^Judge check: 41 items/u;
const judgeCheckLinePattern = /^Judge check: \d+ items?, about \d+ min and \$/u;

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

function talkative(maxTurns: number, count = 1) {
  return makePerson("sam", {
    conversations: Array.from({ length: count }, (_, index) =>
      conversation(`c${index}`, maxTurns)
    ),
  });
}

test("a conversation costs its replies, its simulated-user turns after the opening, and two more judge and user calls", () => {
  const people = [talkative(8)];
  const input = inputFor({ tests: ["conversations"] }, people);
  const estimate = estimateRun(input);
  const perReply = ESTIMATE_DEFAULTS.replySeconds.off;
  const hours =
    (8 * perReply + 7 * ESTIMATE_DEFAULTS.simulatedUserSeconds) / 3600;
  const empty = estimateRun(inputFor({ tests: ["conversations"] }, []));
  assert.ok(
    Math.abs(estimate.hours - empty.hours - hours) < 1e-6 + sageSetupHours(),
    `${estimate.hours - empty.hours} h against ${hours} h`
  );
  const judgeUsd =
    8 * costUsd(prices.judge, ESTIMATE_TOKENS.replyJudge) +
    costUsd(prices.judge, ESTIMATE_TOKENS.conversationJudge);
  const simUsd =
    7 * costUsd(prices.simulatedUser, ESTIMATE_TOKENS.simulatedUserTurn) +
    costUsd(prices.simulatedUser, ESTIMATE_TOKENS.simulatedUserRating);
  assert.ok(Math.abs(estimate.costUsd - judgeUsd - simUsd) < 1e-9);
  assert.match(
    estimate.lines.join("\n"),
    new RegExp(`\\$${simUsd.toFixed(2)} for the simulated user`, "u")
  );
});

/** The Sage start, Chat server start, and model load one person adds, in hours. */
function sageSetupHours(): number {
  return (
    (ESTIMATE_DEFAULTS.sageStartSeconds +
      ESTIMATE_DEFAULTS.eveStartSeconds +
      ESTIMATE_DEFAULTS.modelLoadSeconds) /
    3600
  );
}

test("conversations and repeats multiply, and a sweep that does not name conversations pays for none", () => {
  const people = [talkative(10, 2)];
  const once = estimateRun(inputFor({ tests: ["conversations"] }, people));
  const thrice = estimateRun(
    inputFor({ repeats: 3, tests: ["conversations"] }, people)
  );
  assert.ok(thrice.costUsd > once.costUsd * 2.9);
  assert.ok(thrice.costUsd < once.costUsd * 3.1);
  const none = estimateRun(inputFor({ tests: ["facts"] }, people));
  assert.equal(none.costUsd, 0);
  // A long conversation is the most of its maxTurns, so 30 turns cost more than 8.
  const long = estimateRun(
    inputFor({ tests: ["conversations"] }, [talkative(30)])
  );
  const short = estimateRun(
    inputFor({ tests: ["conversations"] }, [talkative(8)])
  );
  assert.ok(long.costUsd > short.costUsd * 3);
  assert.ok(long.hours > short.hours);
});

test("the judge check counts its conversation items, each a whole-conversation grade", () => {
  const input = inputFor({ tests: ["person"] }, [makePerson("sam")]);
  const without = estimateRun({
    ...input,
    judgeCheck: { dreamItems: 12, replyItems: 22 },
  });
  const withConversations = estimateRun({
    ...input,
    judgeCheck: { conversationItems: 7, dreamItems: 12, replyItems: 22 },
  });
  const added = 7 * costUsd(prices.judge, ESTIMATE_TOKENS.conversationJudge);
  assert.ok(
    Math.abs(withConversations.costUsd - without.costUsd - added) < 1e-9
  );
  assert.ok(
    Math.abs(
      withConversations.hours -
        without.hours -
        (7 * ESTIMATE_DEFAULTS.judgeCheckSecondsPerItem) / 3600
    ) < 1e-9
  );
  assert.match(withConversations.lines[0] ?? "", judgeCheck41Pattern);
});

test("Dream accuracy is one judge call and some time for each entry, and Chat adds nothing to a Dream-only sweep", () => {
  const people = [makePerson("sam", { entries: 10 })];
  const withoutAccuracy = estimateRun(
    inputFor({ memory: ["off"], tests: ["person"] }, people)
  );
  const withAccuracy = estimateRun(
    inputFor({ memory: ["off"], tests: ["person", "dream-accuracy"] }, people)
  );
  const perCall = costUsd(prices.judge, ESTIMATE_TOKENS.dreamSourceJudge);
  assert.ok(Math.abs(withAccuracy.costUsd - 10 * perCall) < 1e-9);
  assert.ok(
    Math.abs(
      withAccuracy.hours -
        withoutAccuracy.hours -
        (10 * ESTIMATE_DEFAULTS.dreamAccuracySecondsPerSource) / 3600
    ) < 1e-9
  );

  // With no Chat there are no Chat server starts and no model loads to wait for.
  const sweep = parseSweepFile({
    memory: ["off"],
    tests: ["person", "dream-accuracy"],
  });
  const setups = expandSetups(sweep);
  const chat = estimateRun({
    ...inputFor(
      { memory: ["off"], tests: ["person", "dream-accuracy"] },
      people
    ),
    plan: buildPlan(setups, people, sweep),
  });
  const noChat = estimateRun({
    ...inputFor(
      { memory: ["off"], tests: ["person", "dream-accuracy"] },
      people
    ),
    plan: buildPlan(setups, people, sweep, { chat: false }),
  });
  const saved =
    ESTIMATE_DEFAULTS.eveStartSeconds + ESTIMATE_DEFAULTS.modelLoadSeconds;
  assert.ok(Math.abs(chat.hours - noChat.hours - saved / 3600) < 1e-9);
});

test("the judge check adds its items' cost and time, and a plan with no check adds nothing", () => {
  const input = inputFor({ tests: ["person"] }, [makePerson("sam")]);
  const without = estimateRun(input);
  assert.ok(!without.lines.some((line) => line.startsWith("Judge check")));
  const check = { dreamItems: 12, replyItems: 22 };
  const withCheck = estimateRun({ ...input, judgeCheck: check });
  const added =
    12 * costUsd(prices.judge, ESTIMATE_TOKENS.dreamSourceJudge) +
    22 * costUsd(prices.judge, ESTIMATE_TOKENS.replyJudge);
  assert.ok(Math.abs(withCheck.costUsd - without.costUsd - added) < 1e-9);
  assert.ok(
    Math.abs(
      withCheck.hours -
        without.hours -
        (34 * ESTIMATE_DEFAULTS.judgeCheckSecondsPerItem) / 3600
    ) < 1e-9
  );
  assert.match(withCheck.lines[0] ?? "", judgeCheckLinePattern);
});

// The plan's night is eight hours with a $50 cap. The estimate runs on default
// timings until a real report gives it better ones, so the hours here are a
// guard against growth and not a forecast.
const SCREEN_HOURS_BUDGET = 9;

async function estimateShipped(name: string) {
  const { sweep, setups } = await loadSweep(name, {});
  const people = selectPeople(await loadPeople(), sweep.tags, {
    conversations: sweep.tests.includes("conversations"),
    excludeTags: sweep.excludeTags,
    openers: sweep.tests.includes("openers"),
  });
  const plan = buildPlan(setups, people, sweep, { chat: true });
  const estimate = estimateRun({
    dreamMisses: new Set(),
    history: new Map(),
    judgeCheck: await judgeCheckSize(),
    plan,
    prices: {
      // AI Gateway's list price for deepseek/deepseek-v4.1-flash on 2026-11-26.
      judge: { inputPerM: 0.3, outputPerM: 1.2 },
      simulatedUser: { inputPerM: 0.2, outputPerM: 0.5 },
    },
    sweep,
  });
  return { estimate, setups, sweep };
}

test("smoke.yaml's estimate, judge check included, fits its spending cap with room to spare", async () => {
  const { estimate, sweep } = await estimateShipped("smoke");
  assert.match(estimate.lines[0] ?? "", judgeCheckLinePattern);
  assert.ok(
    estimate.costUsd < sweep.spendingCapUsd * 0.9,
    `$${estimate.costUsd.toFixed(2)} against a $${sweep.spendingCapUsd} cap`
  );
});

test("screen.yaml sends no fact questions, and its estimate, judge check included, is under its cap and its hours budget", async () => {
  const { estimate, setups, sweep } = await estimateShipped("screen");
  assert.equal(setups.length, 18);
  assert.deepEqual(sweep.tests, ["person", "openers"]);
  assert.ok(
    estimate.costUsd <= sweep.spendingCapUsd,
    `$${estimate.costUsd.toFixed(2)} against a $${sweep.spendingCapUsd} cap:\n${estimate.lines.join("\n")}`
  );
  assert.ok(
    estimate.hours <= SCREEN_HOURS_BUDGET,
    `${estimate.hours.toFixed(1)} h:\n${estimate.lines.join("\n")}`
  );
});

async function plannedShipped(
  name: string,
  overrides: Record<string, unknown> = {}
) {
  const { sweep: loaded } = await loadSweep(name, {});
  const sweep = parseSweepFile({ ...loaded, ...overrides });
  const setups = expandSetups(sweep);
  const people = selectPeople(await loadPeople(), sweep.tags, {
    conversations: sweep.tests.includes("conversations"),
    excludeTags: sweep.excludeTags,
    openers: sweep.tests.includes("openers"),
  });
  return {
    people,
    plan: buildPlan(setups, people, sweep, { chat: true }),
    sweep,
  };
}

test("long-history is left out of default, smoke, quick, and screen, and in the deep sweeps and dream", async () => {
  for (const name of ["default", "smoke", "quick", "screen"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep is planned on its own
    const { people, sweep } = await plannedShipped(name);
    assert.deepEqual(sweep.excludeTags, ["long"], name);
    assert.ok(!people.some((person) => person.id === "long-history"), name);
  }
  for (const name of ["deep", "deep-memory-on", "dream"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep is planned on its own
    const { people, sweep } = await plannedShipped(name);
    assert.deepEqual(sweep.excludeTags, [], name);
    assert.ok(
      people.some((person) => person.id === "long-history"),
      name
    );
  }
});

test("the estimate follows the exclusion: leaving long-history out saves its Dream hours and its conversation", async () => {
  const everyMiss = (
    plan: Awaited<ReturnType<typeof plannedShipped>>["plan"]
  ) =>
    new Set(
      plan.groups.flatMap((group) =>
        plan.people.map((person) => dreamMissKey(group.dreamKeyId, person.id))
      )
    );
  const run = async (overrides: Record<string, unknown>) => {
    const { plan, sweep } = await plannedShipped("deep", overrides);
    return estimateRun({
      dreamMisses: everyMiss(plan),
      history: new Map(),
      plan,
      prices,
      sweep,
    });
  };
  // Memory on, so Dream takes 60 seconds an entry.
  const included = await run({ memory: ["on"] });
  const excluded = await run({ excludeTags: ["long"], memory: ["on"] });
  assert.ok(included.dreamMissCount > excluded.dreamMissCount);
  // About 300 entries at 60 seconds, and a conversation of 30 turns.
  assert.ok(
    included.hours - excluded.hours > 6,
    `${included.hours.toFixed(1)} h against ${excluded.hours.toFixed(1)} h`
  );
  assert.ok(included.costUsd > excluded.costUsd);
});

test("the deep sweeps' estimates, with their placeholders and the judge check, are under their spending cap", async () => {
  for (const name of ["deep", "deep-memory-on"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep is estimated on its own
    const { estimate, sweep } = await estimateShipped(name);
    assert.ok(
      estimate.costUsd <= sweep.spendingCapUsd,
      `${name}: $${estimate.costUsd.toFixed(2)} against a $${sweep.spendingCapUsd} cap:\n${estimate.lines.join("\n")}`
    );
    assert.match(estimate.lines.join("\n"), pattern1);
  }
});

test("deep.yaml runs the person checks and every conversation three times, memory off, on two placeholder setups", async () => {
  const { setups, sweep } = await loadSweep("deep", {});
  assert.deepEqual(sweep.tests, ["person", "conversations"]);
  assert.equal(sweep.repeats, 3);
  assert.deepEqual(sweep.memory, ["off"]);
  assert.deepEqual(sweep.tags, []);
  assert.deepEqual(sweep.excludeTags, []);
  assert.equal(setups.length, 2);
});

test("deep-memory-on.yaml is deep.yaml with memory on, and nothing else different", async () => {
  const off = await loadSweep("deep", {});
  const on = await loadSweep("deep-memory-on", {});
  assert.deepEqual(on.sweep.memory, ["on"]);
  assert.deepEqual(
    { ...on.sweep, memory: off.sweep.memory },
    off.sweep,
    "only memory differs"
  );
  assert.equal(on.setups.length, off.setups.length);
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
