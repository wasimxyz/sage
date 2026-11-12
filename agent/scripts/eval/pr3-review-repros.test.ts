// Review repros for PR 3 (openers, rubric, and Chat checks). Each test states
// what should hold and fails while the bug is there. Nothing here calls a model
// or the network: the judge is a mock model, and the ledger is a temp folder.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import type { ReplyItem } from "../../evals/lib/checks.ts";
import { checksFor } from "../../evals/lib/checks.ts";
import { loadPeople, loadPerson } from "../../evals/lib/dataset.ts";
import { gradesFileName } from "../../evals/lib/dream-grade-cache.ts";
import { createGrader, rubricHash } from "../../evals/lib/grader.ts";
import {
  gradeCheckItem,
  gradeReplyCheckItem,
  loadDreamCheckItems,
  loadReplyCheckItems,
  resolveReplyCheckItem,
} from "../../evals/lib/judge-check.ts";
import { formatJournalContext } from "../../evals/lib/judge-context.ts";
import { totals } from "../../evals/lib/ledger.ts";
import { makeItem, type ScoreHost } from "../../evals/lib/record.ts";
import type { RecordedAssertion } from "../../evals/lib/recorder.ts";
import { gradeReply, recordReplyGrade } from "../../evals/lib/reply-grade.ts";
import { REPLY_TITLES } from "../../evals/lib/rubric.ts";
import {
  parseSweepFile,
  parseTranscriptRow,
  type ReplyGrade,
  rankingEntryFor,
  type Setup,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import { estimateRun } from "./estimate.ts";
import { PASS_CONCURRENCY } from "./passes.ts";
import { selectPeople } from "./people.ts";
import { buildPlan } from "./plan.ts";
import { assembleSetupReport } from "./report.ts";
import { loadSweep } from "./sweep.ts";

// ---------------------------------------------------------------------------
// 1. smoke.yaml's $1 cap and the judge check
// ---------------------------------------------------------------------------

/** The plan's judge price: Kimi K3.1 Pro at $2 in and $10 out per million tokens. */
const KIMI_PRICE = { inputPerM: 2, outputPerM: 10 };
/** Output tokens per judge answer. The runner's own estimate uses 2000 for a reply. */
const REPLY_OUTPUT_TOKENS = 1500;
const DREAM_OUTPUT_TOKENS = 600;
const REPLY_OUTPUT = { tokens: REPLY_OUTPUT_TOKENS };

type Prompt = readonly { content: unknown }[];

function promptText(prompt: Prompt): string {
  return prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as readonly { text?: string }[])
            .map((part) => part.text ?? "")
            .join("")
    )
    .join("");
}

function idsAfter(text: string, label: string): string[] {
  const line = text.split("\n").find((row) => row.startsWith(`${label}: `));
  return line === undefined
    ? []
    : line
        .slice(label.length + 2)
        .split(", ")
        .filter(Boolean);
}

/** A clean answer for whatever the prompt asks: every check passes, every score is 4. */
function answerFor(text: string): string {
  if (!text.includes("Checks to answer:")) {
    return JSON.stringify({ unsupportedClaims: [] });
  }
  const block = text.slice(text.lastIndexOf("Checks to answer:"));
  const verdict = (id: string) => ({
    evidence: "",
    id,
    pass: true,
    reason: "",
  });
  const na = block.includes("N/A, answer with level null")
    ? block.slice(block.indexOf("N/A, answer with level null"))
    : "";
  return JSON.stringify({
    counted: idsAfter(block, "counted").map(verdict),
    hard: idsAfter(block, "hard").map(verdict),
    helpSeen: ["listen"],
    journalErrors: [],
    rubric: idsAfter(block, "rubric").map((id) => ({
      evidence: "",
      id,
      level: na.includes(`${id} (`) ? null : 4,
      reason: "",
    })),
    slips: [],
  });
}

/** A judge that answers after a short wait and bills the prompt's tokens. */
function mockJudge(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      const output = text.includes("Checks to answer:")
        ? REPLY_OUTPUT.tokens
        : DREAM_OUTPUT_TOKENS;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const input = Math.round(text.length / 4);
      return {
        content: [{ text: answerFor(text), type: "text" as const }],
        finishReason: { raw: undefined, unified: "stop" as const },
        usage: {
          inputTokens: {
            cacheRead: undefined,
            cacheWrite: undefined,
            noCache: input,
            total: input,
          },
          outputTokens: { reasoning: undefined, text: output, total: output },
        },
        warnings: [],
      };
    },
  });
}

/** Runs tasks with at most `limit` in flight, like `eve eval --max-concurrency`. */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: a worker runs its tasks one at a time, like one eve slot
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

interface Outcome {
  id: string;
  ok: boolean;
  reason?: string;
}

/** The judge check, Dream half then reply half, through one grader. */
async function judgeCheckTasks(
  grader: ReturnType<typeof createGrader>
): Promise<(() => Promise<Outcome>)[]> {
  const dream = await loadDreamCheckItems();
  const replies = await Promise.all(
    (await loadReplyCheckItems()).map((item) =>
      resolveReplyCheckItem(item, { today: "2026-11-15" })
    )
  );
  return [
    ...dream.map((item) => async () => {
      const result = await gradeCheckItem(grader, item);
      return result.ok
        ? { id: item.id, ok: true }
        : { id: item.id, ok: false, reason: result.reason };
    }),
    ...replies.map((resolved) => async () => {
      const result = await gradeReplyCheckItem(grader, resolved);
      return result.ok
        ? { id: resolved.item.id, ok: true }
        : { id: resolved.item.id, ok: false, reason: result.reason };
    }),
  ];
}

/** smoke.yaml's own replies: sam-example's openers and fact questions, as the grade pass sends them. */
async function smokeReplyTasks(
  grader: ReturnType<typeof createGrader>
): Promise<(() => Promise<Outcome>)[]> {
  const person = await loadPerson("sam-example");
  const context = formatJournalContext(person, { today: "2026-11-15" });
  const items: { id: string; item: ReplyItem; message: string }[] = [
    ...person.personCase.openers.map((opener) => ({
      id: opener.id,
      item: {
        avoid: opener.avoid,
        expect: opener.expect,
        fits: opener.fits,
        journalEmpty: false,
        kind: "opener" as const,
        tags: opener.tags,
      },
      message: opener.message,
    })),
    ...person.personCase.chat.map((chat, index) => ({
      id: `chat-${index + 1}`,
      item: {
        avoid: [],
        expect: "question" as const,
        fits: [],
        journalEmpty: false,
        kind: "chat" as const,
        reference: chat.reference,
        tags: [],
      },
      message: chat.question,
    })),
  ];
  return items.map(({ id, item, message }) => async () => {
    const result = await gradeReply(grader, {
      context,
      item,
      label: `reply ${id}`,
      message,
      reply: "That sounds like a lot to carry. What feels heaviest right now?",
      toolCalls: [],
    });
    return result.ok
      ? { id, ok: true }
      : { id, ok: false, reason: result.reason };
  });
}

test("smoke.yaml's cap covers the judge check and smoke's own reply grades, even at 1000 output tokens", async () => {
  REPLY_OUTPUT.tokens = 1000;
  try {
    const { sweep } = await loadSweep("smoke", {});
    const runDir = join(mkdtempSync(join(tmpdir(), "pr3-repro-")), "run");
    const grader = createGrader({
      capUsd: sweep.spendingCapUsd,
      model: mockJudge(),
      modelId: sweep.judge.model,
      price: KIMI_PRICE,
      runDir,
      sweepId: "smoke-repro",
    });
    const check = await pool(
      await judgeCheckTasks(grader),
      PASS_CONCURRENCY.grade
    );
    const replies = await pool(
      await smokeReplyTasks(grader),
      PASS_CONCURRENCY.grade
    );
    const refused = [...check, ...replies].filter((result) => !result.ok);
    assert.deepEqual(
      refused.map((result) => `${result.id}: ${result.reason}`),
      [],
      `spent $${totals(runDir).spentUsd.toFixed(2)}; the person pass's fact grades, left out here, would come first and make it worse`
    );
  } finally {
    REPLY_OUTPUT.tokens = REPLY_OUTPUT_TOKENS;
  }
});

test("smoke.yaml's spending cap leaves room for the whole judge check", async () => {
  const { sweep } = await loadSweep("smoke", {});
  const runDir = join(mkdtempSync(join(tmpdir(), "pr3-repro-")), "run");
  const grader = createGrader({
    capUsd: sweep.spendingCapUsd,
    model: mockJudge(),
    modelId: sweep.judge.model,
    price: KIMI_PRICE,
    runDir,
    sweepId: "smoke-repro",
  });
  const results = await pool(
    await judgeCheckTasks(grader),
    PASS_CONCURRENCY.grade
  );
  const refused = results.filter((result) => !result.ok);
  // Any item left unchecked stops the sweep before it builds anything.
  assert.deepEqual(
    refused.map((result) => `${result.id}: ${result.reason}`),
    [],
    `${refused.length} of ${results.length} judge-check items were not graded under smoke's $${sweep.spendingCapUsd} cap (spent $${totals(runDir).spentUsd.toFixed(2)})`
  );
});

// ---------------------------------------------------------------------------
// 2. A counted check the judge leaves undecided
// ---------------------------------------------------------------------------

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

const ventItem: ReplyItem = {
  avoid: [],
  expect: "venting",
  fits: ["listen"],
  journalEmpty: false,
  kind: "opener",
  tags: [],
};

/** A grade where every check passes, but the judge answers `null` for `undecided`. */
function gradeWithNull(undecided: string): ReplyGrade {
  const applied = checksFor(ventItem);
  const verdict = (id: string) => ({
    evidence: "",
    id,
    pass: id === undecided ? null : true,
    reason: id === undecided ? "unsure" : "",
  });
  return {
    counted: applied.counted.map(verdict) as ReplyGrade["counted"],
    hard: applied.hard.map(verdict) as ReplyGrade["hard"],
    helpSeen: ["listen"],
    journalErrors: [],
    rubric: applied.rubric.map((ask) => ({
      evidence: "",
      id: ask.id,
      level: 4,
      reason: "",
    })),
    slips: [],
  };
}

function reportWith(grade: ReplyGrade) {
  const id = setupIdOf(setup);
  const itemId = "sam/opener/rent";
  const ref = makeItem({ itemId, kind: "opener", person: "sam" }, id, 1);
  const eve = fakeEve();
  recordReplyGrade(eve.host, ref, 1, ventItem, {
    callId: "call-1",
    costUsd: 0.03,
    grade,
    model: "moonshotai/kimi-k3.1-pro",
    ok: true,
    rubric: "abcdef0123",
  });
  const metadata = {
    itemId,
    kind: "opener",
    person: "sam",
    repeat: 1,
    setupId: id,
  };
  const base = {
    completedAt: "2026-11-10T03:00:01.000Z",
    id: itemId,
    metadata,
    startedAt: "2026-11-10T03:00:00.000Z",
    verdict: "passed" as const,
  };
  const chat = fakeEve();
  chat.host
    .score({ metadata: { checkId: "turn-works", tier: "counted" }, score: 1 })
    .label("counted:turn-works")
    .soft(1);
  const report = assembleSetupReport({
    gitCommit: "abc1234",
    people: ["sam"],
    promptShas: { chat: "0123456789ab", dream: null },
    rows: [
      { pass: "chat", row: { ...base, assertions: chat.assertions } },
      { pass: "grade", row: { ...base, assertions: eve.assertions } },
    ],
    setup,
    sweep: parseSweepFile({ tests: ["openers"] }),
    sweepId: "sweep-1",
    transcripts: [
      parseTranscriptRow({
        ended: "done",
        itemId,
        journal: "own",
        kind: "opener",
        person: "sam",
        repeat: 1,
        setupId: id,
        turns: [
          { role: "user", text: "Rent is due Friday." },
          { role: "assistant", text: "That sounds stressful." },
        ],
      }),
    ],
  });
  const [item] = report.items;
  assert.ok(item !== undefined);
  return { item, ranking: rankingEntryFor(report) };
}

test("a hard check the judge answers null is not graded (the baseline)", () => {
  const { item, ranking } = reportWith(gradeWithNull("no-severe-unsupported"));
  assert.equal(item.status, "not-graded");
  assert.equal(ranking.incomplete, true);
});

test("a counted check that applies, answered null, is not graded like a hard check, not N/A", () => {
  const { item, ranking } = reportWith(gradeWithNull("no-overreach"));
  const check = item.turns[1]?.checks.find((c) => c.id === "no-overreach");
  assert.equal(
    check?.outcome,
    "not-graded",
    "the code says no-overreach applies to every reply, and the prompt only offers true or false"
  );
  assert.equal(item.status, "not-graded");
  assert.equal(ranking.incomplete, true);
});

test("a rubric item that applies, scored null, is not graded, not N/A", () => {
  const grade = gradeWithNull("none");
  grade.rubric = grade.rubric.map((score) =>
    score.id === "questions-help" ? { ...score, level: null } : score
  );
  const { item, ranking } = reportWith(grade);
  // questions-help has no N/A case in the rubric text or the labels.
  assert.equal(item.status, "not-graded");
  assert.equal(ranking.incomplete, true);
});

// ---------------------------------------------------------------------------
// 3. The reply rubric and Dream's grade cache
// ---------------------------------------------------------------------------

test("a change that only touches the reply grade keeps the cached Dream grades", () => {
  const model = "moonshotai/kimi-k3.1-pro";
  const before = gradesFileName(model, rubricHash());
  const titles = REPLY_TITLES as { reply: string };
  const original = titles.reply;
  try {
    titles.reply = "Sage's reply to grade, reworded";
    const after = gradesFileName(model, rubricHash());
    assert.equal(
      after,
      before,
      "Dream accuracy reads its cached grades from a file named by the global rubric hash"
    );
  } finally {
    titles.reply = original;
  }
});

// ---------------------------------------------------------------------------
// 4. screen.yaml and the night
// ---------------------------------------------------------------------------

test("screen.yaml fits the plan's 8-hour night and its $50 cap, by the runner's own estimate", async () => {
  const { sweep, setups } = await loadSweep("screen", {});
  const people = selectPeople(await loadPeople(), sweep.tags, {
    openers: sweep.tests.includes("openers"),
  });
  const plan = buildPlan(setups, people, sweep, { chat: true });
  const estimate = estimateRun({
    dreamMisses: new Set(),
    history: new Map(),
    plan,
    prices: {
      judge: KIMI_PRICE,
      simulatedUser: { inputPerM: 0.2, outputPerM: 0.5 },
    },
    sweep,
  });
  assert.equal(setups.length, 18);
  assert.ok(
    estimate.hours <= 8 && estimate.costUsd <= sweep.spendingCapUsd,
    `${estimate.hours.toFixed(1)} h and $${estimate.costUsd.toFixed(2)} (no cached-input price), even with every Dream cached:\n${estimate.lines.join("\n")}`
  );
});
