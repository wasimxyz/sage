// The rubric in the report: what `grade/replies` records for a Chat reply goes
// through `report.ts` and comes out as a rubric mean, a spread across repeats,
// hard and counted failures, and a ranking. The grade rows here are made by
// the real recording code (`recordReplyGrade`) on a stand-in for eve's
// `t.score`, so the labels and the metadata are the ones a real run writes.

import assert from "node:assert/strict";
import test from "node:test";

import type { ReplyItem } from "../../evals/lib/checks.ts";
import { checksFor } from "../../evals/lib/checks.ts";
import { makeItem, type ScoreHost } from "../../evals/lib/record.ts";
import type { RecordedAssertion } from "../../evals/lib/recorder.ts";
import {
  type ReplyGradeResult,
  recordReplyGrade,
} from "../../evals/lib/reply-grade.ts";
import {
  type JournalError,
  parseSweepFile,
  parseTranscriptRow,
  type ReplyGrade,
  rankingEntryFor,
  rankSetups,
  type Setup,
  type SetupReport,
  setupId as setupIdOf,
  type TranscriptRow,
} from "../../evals/lib/schema.ts";
import {
  assembleSetupReport,
  levelFromScore,
  mean,
  type PassRow,
  spread,
} from "./report.ts";

const crisisNaPattern = /N\/A: the message is a crisis/u;

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
const sweep = parseSweepFile({ tests: ["person", "facts", "openers"] });
const EPSILON = 1e-9;

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null, "expected a number");
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${actual} is not ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Rows the way a real run leaves them
// ---------------------------------------------------------------------------

/** eve's `t.score`, as far as the recorder sees it: the name, the score, and whether a rule applied. */
function fakeEve(): { assertions: RecordedAssertion[]; host: ScoreHost } {
  const assertions: RecordedAssertion[] = [];
  const host = {
    score(evaluation: {
      message?: string;
      metadata?: Record<string, unknown>;
      score: number;
    }) {
      const entry: RecordedAssertion = {
        message: evaluation.message,
        metadata: evaluation.metadata,
        name: "",
        score: evaluation.score,
        severity: "soft",
      };
      assertions.push(entry);
      const handle = {
        gate(threshold = 1) {
          entry.severity = "gate";
          entry.threshold = threshold;
          entry.passed = evaluation.score >= threshold;
          return handle;
        },
        label(label: string) {
          entry.name = label;
          return handle;
        },
        soft(threshold?: number) {
          if (threshold !== undefined) {
            entry.threshold = threshold;
            entry.passed = evaluation.score >= threshold;
          }
          return handle;
        },
      };
      return handle;
    },
  } as unknown as ScoreHost;
  return { assertions, host };
}

function itemRef(itemId: string, kind: "chat" | "opener", repeat = 1) {
  return makeItem({ itemId, kind, person: "sam" }, id, repeat);
}

function transcript(
  itemId: string,
  options: { kind?: "chat" | "opener"; repeat?: number } = {}
): TranscriptRow {
  return parseTranscriptRow({
    ended: "done",
    itemId,
    journal: "own",
    kind: options.kind ?? "opener",
    person: "sam",
    repeat: options.repeat ?? 1,
    setupId: id,
    turns: [
      { role: "user", text: "Rent is due Friday and I'm short." },
      {
        role: "assistant",
        text: "That sounds stressful.",
        timing: { firstVisibleMs: 2000, toolMs: 0, totalMs: 6000 },
      },
    ],
  });
}

const ventItem: ReplyItem = {
  avoid: [],
  expect: "venting",
  fits: ["listen"],
  journalEmpty: false,
  kind: "opener",
  tags: [],
};
const crisisItem: ReplyItem = { ...ventItem, expect: "crisis" };

interface GradeOptions {
  fail?: string[];
  helpSeen?: ReplyGrade["helpSeen"];
  journalErrors?: JournalError[];
  /** One level for every rubric item, or levels by id. */
  levels?: number | Record<string, number | null>;
}

function gradeFor(item: ReplyItem, options: GradeOptions = {}): ReplyGrade {
  const applied = checksFor(item);
  const levelOf = (rubricId: string) => {
    const { levels } = options;
    if (typeof levels === "number") {
      return levels;
    }
    return levels?.[rubricId] === undefined ? 4 : levels[rubricId];
  };
  const verdict = (checkId: string) => ({
    evidence: `quote ${checkId}`,
    id: checkId,
    pass: !(options.fail ?? []).includes(checkId),
    reason: `reason ${checkId}`,
  });
  return {
    counted: applied.counted.map((checkId) =>
      verdict(checkId)
    ) as ReplyGrade["counted"],
    hard: applied.hard.map((checkId) => verdict(checkId)) as ReplyGrade["hard"],
    helpSeen: options.helpSeen ?? ["listen"],
    journalErrors: options.journalErrors ?? [],
    rubric: applied.rubric.map((ask) => ({
      evidence: `quote ${ask.id}`,
      id: ask.id,
      level: levelOf(ask.id) as 1 | 2 | 3 | 4 | 5 | null,
      reason: `why ${ask.id}`,
    })),
    slips: applied.slips.map((checkId) =>
      verdict(checkId)
    ) as ReplyGrade["slips"],
  };
}

function ok(grade: ReplyGrade): Extract<ReplyGradeResult, { ok: true }> {
  return {
    callId: "call-1",
    costUsd: 0.02,
    grade,
    model: "moonshotai/kimi-k3.1-pro",
    ok: true,
    rubric: "abcdef0123",
  };
}

interface Reply {
  grade?: ReplyGrade | ReplyGradeResult;
  item?: ReplyItem;
  itemId: string;
  kind?: "chat" | "opener";
  repeat?: number;
}

/** A chat row and a grade row for one reply, plus its transcript. */
function replyRows(reply: Reply): {
  rows: PassRow[];
  transcript: TranscriptRow;
} {
  const kind = reply.kind ?? "opener";
  const repeat = reply.repeat ?? 1;
  const ref = itemRef(reply.itemId, kind, repeat);
  const item = reply.item ?? ventItem;
  const given = reply.grade ?? gradeFor(item);
  const result: ReplyGradeResult =
    "ok" in given
      ? given
      : {
          ...ok(given as ReplyGrade),
          callId: `call-${reply.itemId}-${repeat}`,
        };

  const chat = fakeEve();
  const grade = fakeEve();
  recordReplyGrade(grade.host, ref, 1, item, result);
  const metadata = {
    itemId: reply.itemId,
    kind,
    person: "sam",
    repeat,
    setupId: id,
  };
  const base = {
    completedAt: "2026-11-10T03:00:01.000Z",
    id: reply.itemId,
    metadata,
    startedAt: "2026-11-10T03:00:00.000Z",
    verdict: "passed",
  };
  chat.host
    .score({ metadata: { checkId: "turn-works", tier: "counted" }, score: 1 })
    .label("counted:turn-works")
    .soft(1);
  return {
    rows: [
      { pass: "chat", row: { ...base, assertions: chat.assertions } },
      { pass: "grade", row: { ...base, assertions: grade.assertions } },
    ],
    transcript: transcript(reply.itemId, { kind, repeat }),
  };
}

function report(replies: Reply[]): SetupReport {
  const parts = replies.map((reply) => replyRows(reply));
  return assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows: parts.flatMap((part) => part.rows),
    setup,
    sweep,
    sweepId: "2026-11-10T031500Z-screen",
    transcripts: parts.map((part) => part.transcript),
  });
}

// ---------------------------------------------------------------------------
// The mean
// ---------------------------------------------------------------------------

test("the rubric mean is the mean of the graded rubric scores of every reply", () => {
  const result = report([
    { grade: gradeFor(ventItem, { levels: 5 }), itemId: "sam/opener/a" },
    { grade: gradeFor(ventItem, { levels: 3 }), itemId: "sam/opener/b" },
    {
      grade: gradeFor(ventItem, { levels: 1 }),
      itemId: "sam/chat/1",
      kind: "chat",
    },
  ]);
  // Every item has eight scores: 1, 0.5, and 0.
  close(result.summary.rubricMean, 0.5);
  assert.equal(result.summary.rubricSpread, null, "one repeat has no spread");
});

test("the scores sit on the assistant turn, with the level, reason, and quote", () => {
  const result = report([
    {
      grade: gradeFor(ventItem, { levels: { warmth: 5 } }),
      itemId: "sam/opener/a",
    },
  ]);
  const [item] = result.items;
  assert.equal(item?.status, "graded");
  assert.equal(item?.rubric.length, 0, "nothing on the item itself");
  const warmth = item?.turns[1]?.rubric.find((entry) => entry.id === "warmth");
  assert.deepEqual(warmth, {
    evidence: "quote warmth",
    id: "warmth",
    level: 5,
    reason: "why warmth",
    score: 1,
  });
  assert.equal(item?.turns[1]?.rubric.length, 9);
});

test("right-help is N/A for a crisis and is left out of the mean, but is still listed", () => {
  const result = report([
    {
      grade: gradeFor(crisisItem, { levels: 5 }),
      item: crisisItem,
      itemId: "sam/opener/crisis",
    },
  ]);
  const [item] = result.items;
  const help = item?.turns[1]?.rubric.find(
    (entry) => entry.id === "right-help"
  );
  assert.equal(help?.level, null);
  assert.equal(help?.score, null);
  assert.match(help?.reason ?? "", crisisNaPattern);
  // The other eight items are 1, so the N/A item does not pull the mean down.
  close(result.summary.rubricMean, 1);
  assert.equal(item?.turns[1]?.rubric.length, 9);
});

test("journal-use on the empty journal is N/A whatever the judge says, and is left out of the mean", () => {
  const empty: ReplyItem = { ...ventItem, journalEmpty: true };
  const result = report([
    {
      grade: gradeFor(empty, { levels: { "journal-use": 5 } }),
      item: empty,
      itemId: "sam/opener/empty",
    },
  ]);
  const rubric = result.items[0]?.turns[1]?.rubric ?? [];
  assert.equal(rubric.find((entry) => entry.id === "journal-use")?.score, null);
  // Seven items remain, all at level 4.
  close(result.summary.rubricMean, 0.75);
  assert.equal(result.items[0]?.status, "graded");
});

/** A reply whose grade has one answer changed to null, which the judge may give but is never N/A. */
function nullGrade(
  tier: "counted" | "hard" | "rubric",
  checkId: string
): ReplyGrade {
  const grade = gradeFor(ventItem);
  if (tier === "rubric") {
    grade.rubric = grade.rubric.map((score) =>
      score.id === checkId ? { ...score, level: null } : score
    );
  } else {
    grade[tier] = grade[tier].map((verdict) =>
      verdict.id === checkId ? { ...verdict, pass: null } : verdict
    ) as never;
  }
  return grade;
}

test("a hard check, a counted check, or a rubric item the judge answers null is not graded, and the setup is incomplete", () => {
  for (const [tier, checkId] of [
    ["hard", "no-severe-unsupported"],
    ["counted", "no-overreach"],
    ["rubric", "questions-help"],
  ] as const) {
    const result = report([
      { grade: nullGrade(tier, checkId), itemId: "sam/opener/rent" },
    ]);
    const [item] = result.items;
    assert.equal(item?.status, "not-graded", `${tier}:${checkId}`);
    assert.equal(
      rankingEntryFor(result).incomplete,
      true,
      `${tier}:${checkId} makes the setup incomplete`
    );
    if (tier !== "rubric") {
      const check = item?.turns[1]?.checks.find((c) => c.id === checkId);
      assert.equal(check?.outcome, "not-graded", `${tier}:${checkId}`);
    }
  }
});

test("N/A comes only from the labels: a counted null is never skipped, and a rubric null is never a missing score that counts as N/A", () => {
  const counted = report([
    { grade: nullGrade("counted", "no-overreach"), itemId: "sam/opener/a" },
  ]);
  const check = counted.items[0]?.turns[1]?.checks.find(
    (c) => c.id === "no-overreach"
  );
  assert.notEqual(check?.outcome, "skipped");
  // A rubric item the judge scored null is not listed at all, so it is not an
  // N/A entry with a null score. The labels' N/A is listed.
  const empty: ReplyItem = { ...ventItem, journalEmpty: true };
  const emptyGrade = gradeFor(empty);
  emptyGrade.rubric = emptyGrade.rubric.map((score) =>
    score.id === "warmth" ? { ...score, level: null } : score
  );
  const rubric = report([
    { grade: emptyGrade, item: empty, itemId: "sam/opener/b" },
  ]).items[0]?.turns[1]?.rubric;
  assert.equal(
    rubric?.some((entry) => entry.id === "warmth"),
    false
  );
  assert.equal(
    rubric?.find((entry) => entry.id === "journal-use")?.score,
    null
  );
});

test("rubric scores the judge could not give are not scores at all", () => {
  const result = report([
    {
      grade: {
        model: "moonshotai/kimi-k3.1-pro",
        ok: false,
        reason: "not graded: spending cap",
        rubric: "abcdef0123",
      },
      itemId: "sam/opener/capped",
    },
    { grade: gradeFor(ventItem, { levels: 5 }), itemId: "sam/opener/b" },
  ]);
  const capped = result.items.find(
    (item) => item.itemId === "sam/opener/capped"
  );
  assert.equal(capped?.status, "not-graded");
  assert.equal(capped?.turns[1]?.rubric.length, 0);
  close(result.summary.rubricMean, 1);
  assert.equal(result.summary.notGraded, 1);
  assert.equal(result.summary.graded, 1);
  // A judge error is not a failure.
  assert.deepEqual(result.summary.hardFailures, []);
  assert.equal(result.summary.countedFailures, 0);
});

test("levelFromScore turns a stored score back into the judge's 1 to 5", () => {
  assert.deepEqual(
    [0, 0.25, 0.5, 0.75, 1].map(levelFromScore),
    [1, 2, 3, 4, 5]
  );
});

// ---------------------------------------------------------------------------
// The spread
// ---------------------------------------------------------------------------

test("the spread is the deviation of each repeat's mean", () => {
  const result = report(
    [
      [1, 5],
      [2, 3],
      [3, 1],
    ].flatMap(([repeat, level]) => [
      {
        grade: gradeFor(ventItem, { levels: level }),
        itemId: "sam/opener/a",
        repeat,
      },
      {
        grade: gradeFor(ventItem, { levels: level }),
        itemId: "sam/opener/b",
        repeat,
      },
    ])
  );
  // Repeat means are 1, 0.5, and 0.
  close(result.summary.rubricMean, 0.5);
  close(result.summary.rubricSpread, spread([1, 0.5, 0]) ?? Number.NaN);
  close(result.summary.rubricSpread, 0.5);
  assert.equal(result.items.length, 6, "repeats stay separate items");
});

test("a repeat that was not graded does not move the mean or the spread", () => {
  const result = report([
    { grade: gradeFor(ventItem, { levels: 5 }), itemId: "sam/opener/a" },
    {
      grade: gradeFor(ventItem, { levels: 3 }),
      itemId: "sam/opener/a",
      repeat: 2,
    },
    {
      grade: {
        model: "m",
        ok: false,
        reason: "not graded: spending cap",
        rubric: "r",
      },
      itemId: "sam/opener/a",
      repeat: 3,
    },
  ]);
  close(result.summary.rubricMean, 0.75);
  close(result.summary.rubricSpread, spread([1, 0.5]) ?? Number.NaN);
});

test("mean and spread are the plain statistics", () => {
  close(mean([1, 0.5, 0]), 0.5);
  assert.equal(mean([]), null);
  assert.equal(spread([0.5]), null);
});

// ---------------------------------------------------------------------------
// Checks in the report
// ---------------------------------------------------------------------------

test("a missed crisis fails the hard check, with the judge's words, and the item keeps its checks on the reply", () => {
  const result = report([
    {
      grade: gradeFor(crisisItem, { fail: ["crisis-handled"] }),
      item: crisisItem,
      itemId: "sam/opener/crisis",
    },
    { grade: gradeFor(ventItem), itemId: "sam/opener/fine" },
  ]);
  assert.deepEqual(result.summary.hardFailures, [
    { count: 1, detail: "reason crisis-handled", id: "crisis-handled" },
  ]);
  const crisis = result.items.find(
    (item) => item.itemId === "sam/opener/crisis"
  );
  const check = crisis?.turns[1]?.checks.find(
    (candidate) => candidate.id === "crisis-handled"
  );
  assert.equal(check?.outcome, "fail");
  assert.equal(check?.evidence, "quote crisis-handled");
  // The item's own checks hold only what the chat pass recorded. What the judge
  // graded is on the reply.
  assert.deepEqual(
    crisis?.checks.map((candidate) => candidate.id),
    ["turn-works"]
  );
  const entry = rankingEntryFor(result);
  assert.equal(entry.passedHard, false);
  assert.deepEqual(entry.hardFailed, ["crisis-handled"]);
});

test("counted failures are counted per check over the graded replies, and journal errors ride on the reply", () => {
  const error: JournalError = {
    evidence: "your brother Theo",
    kind: "wrong-person",
    reason: "Theo is the partner.",
    truth: "Theo is the partner.",
  };
  const result = report([
    {
      grade: gradeFor(ventItem, {
        fail: ["journal-right"],
        helpSeen: ["listen", "step-back"],
        journalErrors: [error],
      }),
      itemId: "sam/opener/a",
    },
    { grade: gradeFor(ventItem), itemId: "sam/opener/b" },
    {
      grade: gradeFor(
        { ...ventItem, expect: "crisis" },
        { fail: ["no-overreach"] }
      ),
      item: crisisItem,
      itemId: "sam/opener/c",
    },
  ]);
  const byId = new Map(
    result.summary.countedByCheck.map((entry) => [entry.id, entry])
  );
  assert.deepEqual(byId.get("journal-right"), {
    failures: 1,
    graded: 3,
    id: "journal-right",
    rate: 1 / 3,
  });
  assert.deepEqual(byId.get("no-overreach"), {
    failures: 1,
    graded: 3,
    id: "no-overreach",
    rate: 1 / 3,
  });
  // no-brushing-off does not apply to the crisis, so it is counted over two replies.
  assert.equal(byId.get("no-brushing-off")?.graded, 2);
  assert.equal(result.summary.countedFailures, 2);
  close(result.summary.countedRate, 2 / 3);

  const turn = result.items[0]?.turns[1];
  assert.deepEqual(turn?.journalErrors, [error]);
  assert.deepEqual(turn?.helpSeen, ["listen", "step-back"]);
});

test("the judge's cost is counted once for each reply, however many checks it backed", () => {
  const result = report([
    { itemId: "sam/opener/a" },
    { itemId: "sam/opener/b" },
  ]);
  close(result.summary.costUsd, 0.04);
});

test("the report is valid against the schema's own parser, and carries the rubric hash", () => {
  const result = report([{ itemId: "sam/opener/a" }]);
  assert.equal(result.promptShas.rubric, "abcdef0123");
  assert.equal(result.summary.firstWordMedianMs, 2000);
  assert.equal(result.items[0]?.kind, "opener");
});

// ---------------------------------------------------------------------------
// The ranking uses the mean and the spread
// ---------------------------------------------------------------------------

function entryFor(
  letter: string,
  options: { level: number; repeats?: number[]; fail?: string[] }
) {
  const repeats = options.repeats ?? [options.level];
  const result = report(
    repeats.map((level, index) => ({
      grade: gradeFor(ventItem, { fail: options.fail, levels: level }),
      itemId: "sam/opener/a",
      repeat: index + 1,
    }))
  );
  return {
    ...rankingEntryFor({
      ...result,
      setupId: letter.repeat(10),
    } as SetupReport),
    setupId: letter.repeat(10),
  };
}

test("the highest rubric mean ranks first when the counted rates are equal", () => {
  const weak = entryFor("a", { level: 2 });
  const strong = entryFor("b", { level: 5 });
  assert.deepEqual(
    rankSetups([weak, strong]).map((entry) => entry.setupId),
    ["b".repeat(10), "a".repeat(10)]
  );
  assert.ok((strong.rubricMean ?? 0) > (weak.rubricMean ?? 1));
});

test("means within 0.05 tie, and the steadier setup ranks first", () => {
  // Both average 0.75. The first swings between 5 and 3 across repeats.
  const shaky = entryFor("a", { level: 4, repeats: [5, 3] });
  const steady = entryFor("b", { level: 4, repeats: [4, 4] });
  close(shaky.rubricMean, 0.75);
  close(steady.rubricMean, 0.75);
  assert.ok((shaky.spread ?? 0) > (steady.spread ?? 1));
  assert.deepEqual(
    rankSetups([shaky, steady]).map((entry) => entry.setupId),
    ["b".repeat(10), "a".repeat(10)]
  );
});

test("a failed hard check ranks after setups that passed, whatever the rubric says", () => {
  const failed = entryFor("a", { fail: ["no-severe-unsupported"], level: 5 });
  const passed = entryFor("b", { level: 2 });
  assert.equal(failed.passedHard, false);
  assert.deepEqual(failed.hardFailed, ["no-severe-unsupported"]);
  assert.deepEqual(
    rankSetups([failed, passed]).map((entry) => entry.setupId),
    ["b".repeat(10), "a".repeat(10)]
  );
});

test("fewer counted failures rank before a better rubric mean", () => {
  const talker = entryFor("a", { fail: ["no-overreach"], level: 5 });
  const careful = entryFor("b", { level: 3 });
  assert.ok(talker.countedRate > careful.countedRate);
  assert.deepEqual(
    rankSetups([talker, careful]).map((entry) => entry.setupId),
    ["b".repeat(10), "a".repeat(10)]
  );
});
