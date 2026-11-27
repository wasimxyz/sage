// The judge check as the runner sees it: how it reads the rows the eval
// records, when it stops the sweep, and what the `eve eval` process is given.
// The eval itself (and the labeled items) is tested in
// `agent/evals/lib/judge-check.test.ts`.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import type { ReplyItem } from "../../evals/lib/checks.ts";
import { loadPerson } from "../../evals/lib/dataset.ts";
import { createGrader } from "../../evals/lib/grader.ts";
import {
  gradeCheckItem,
  gradeReplyCheckItem,
  loadDreamCheckItems,
  loadReplyCheckItems,
  resolveReplyCheckItem,
} from "../../evals/lib/judge-check.ts";
import { formatJournalContext } from "../../evals/lib/judge-context.ts";
import { totals } from "../../evals/lib/ledger.ts";
import type {
  RecordedAssertion,
  RecordedEvalResult,
} from "../../evals/lib/recorder.ts";
import { gradeReply } from "../../evals/lib/reply-grade.ts";
import {
  EVAL_ENV,
  JUDGE_CHECK_PERSON,
  parseSweepFile,
  parseSweepSummary,
} from "../../evals/lib/schema.ts";
import {
  isJudgeCheckRow,
  JUDGE_CHECK_EVAL,
  judgeCheckFiles,
  judgeCheckResult,
  judgeCheckSize,
  readJudgeCheck,
  runJudgeCheck,
} from "./judge-check.ts";
import { ENV_DREAM_KEY, ENV_SWEEP_ID, PASS_CONCURRENCY } from "./passes.ts";
import { assembleSweepSummary } from "./report.ts";
import { loadSweep } from "./sweep.ts";
import { fakeEve, tempDir } from "./test-fixtures.ts";

const missedPattern =
  /^ {2}missed no-severe-unsupported in judge-check\/dream\/lost-mia-death: The judge found no severe claim/mu;
const falseAlarmPattern =
  /^ {2}false-alarm dream-supported in judge-check\/dream\/clean-run: The judge flagged/mu;
const stoppedPattern = /sweep stopped before it built or ran anything/u;
const cannotBeCheckedPattern = /The judge could not be checked/u;
const capPattern = /judge-check\/dream\/clean-run: not graded: spending cap/u;
const noItemsPattern = /recorded no items/u;
const crashPattern = /The judge check crashed \(exit 2\)/u;
const matchedPattern = /matched the label on all 2 items/u;
const crashedExit1Pattern = /The judge check crashed \(exit 1\)/u;
const didNotFinishPattern = /did not finish cleanly/u;

// ---------------------------------------------------------------------------
// Rows, as the eval records them
// ---------------------------------------------------------------------------

function itemRow(
  id: string,
  assertion: RecordedAssertion | null,
  extra: Partial<RecordedEvalResult> = {}
): RecordedEvalResult {
  const itemId = `judge-check/dream/${id}`;
  return {
    assertions: assertion === null ? [] : [assertion],
    completedAt: "2026-11-10T03:00:01.000Z",
    id: itemId,
    metadata: {
      itemId,
      kind: "dream-source",
      person: JUDGE_CHECK_PERSON,
      repeat: 1,
      setupId: "judge-check",
    },
    startedAt: "2026-11-10T03:00:00.000Z",
    verdict: "passed",
    ...extra,
  };
}

function verdict(
  passed: boolean | undefined,
  metadata: Record<string, unknown> = {}
): RecordedAssertion {
  return {
    metadata: { checkId: "judge-check", tier: "hard", ...metadata },
    name: "hard:judge-check",
    passed,
    score: passed === true ? 1 : 0,
    severity: "gate",
  };
}

const planted = (id: string) =>
  itemRow(
    id,
    verdict(false, {
      misses: [
        {
          check: "no-severe-unsupported",
          detail: "The judge found no severe claim, but the item has one.",
          itemId: `judge-check/dream/${id}`,
          kind: "missed",
        },
      ],
    })
  );

const falseAlarm = (id: string) =>
  itemRow(
    id,
    verdict(false, {
      misses: [
        {
          check: "dream-supported",
          detail:
            'The judge flagged a other claim that the label says is not there: "ran".',
          itemId: `judge-check/dream/${id}`,
          kind: "false-alarm",
        },
      ],
    })
  );

const ok = (id: string) => itemRow(id, verdict(true));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("every item that matched its label is a pass, and the sweep goes on", () => {
  const reading = readJudgeCheck([ok("lost-mia-death"), ok("clean-run")]);
  assert.deepEqual(reading, { checked: 2, misses: [], unchecked: [] });
  const result = judgeCheckResult(reading);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { misses: [], passed: true });
  assert.match(result.lines.join("\n"), matchedPattern);
});

test("a planted failure the judge let through is a miss with its check, kind, detail, and item", () => {
  const reading = readJudgeCheck([planted("lost-mia-death"), ok("clean-run")]);
  assert.equal(reading.checked, 1);
  assert.deepEqual(reading.misses, [
    {
      check: "no-severe-unsupported",
      detail: "The judge found no severe claim, but the item has one.",
      itemId: "judge-check/dream/lost-mia-death",
      kind: "missed",
    },
  ]);
  const result = judgeCheckResult(reading);
  assert.equal(result.ok, false);
  assert.equal(result.summary.passed, false);
  assert.deepEqual(result.summary.misses, reading.misses);
  const text = result.lines.join("\n");
  assert.match(text, missedPattern);
  assert.match(text, stoppedPattern);
});

test("a clean item the judge flagged is a false alarm, and both kinds are listed", () => {
  const result = judgeCheckResult(
    readJudgeCheck([planted("lost-mia-death"), falseAlarm("clean-run")])
  );
  assert.equal(result.ok, false);
  const text = result.lines.join("\n");
  assert.match(text, missedPattern);
  assert.match(text, falseAlarmPattern);
  assert.equal(result.summary.misses.length, 2);
});

test("a failed item with no misses in its metadata still names the item", () => {
  const reading = readJudgeCheck([
    itemRow("odd", verdict(false, { reason: "They do not match." })),
  ]);
  assert.deepEqual(reading.misses, [
    {
      check: "judge-check",
      detail: "They do not match.",
      itemId: "judge-check/dream/odd",
      kind: "missed",
    },
  ]);
});

test("an item the judge could not grade means the judge could not be checked", () => {
  const reading = readJudgeCheck([
    ok("lost-mia-death"),
    itemRow(
      "clean-run",
      verdict(undefined, {
        notGraded: true,
        reason: "not graded: spending cap",
      })
    ),
  ]);
  assert.equal(reading.checked, 1);
  assert.deepEqual(reading.unchecked, [
    {
      itemId: "judge-check/dream/clean-run",
      reason: "not graded: spending cap",
    },
  ]);
  const result = judgeCheckResult(reading);
  assert.equal(result.ok, false);
  assert.equal(result.summary.passed, false);
  assert.deepEqual(result.summary.misses, []);
  const text = result.lines.join("\n");
  assert.match(text, cannotBeCheckedPattern);
  assert.match(text, capPattern);
});

test("an item that recorded nothing, or whose eval threw or was skipped, is unchecked", () => {
  const reading = readJudgeCheck([
    itemRow("threw", null, { error: "boom", verdict: "failed" }),
    itemRow("skipped", null, {
      skipReason: "No Dream judge-check items.",
      verdict: "skipped",
    }),
    itemRow("silent", null),
  ]);
  assert.deepEqual(
    reading.unchecked.map((item) => [item.itemId, item.reason]),
    [
      ["judge-check/dream/threw", "boom"],
      ["judge-check/dream/skipped", "No Dream judge-check items."],
      ["judge-check/dream/silent", "The item recorded no verdict at all."],
    ]
  );
  assert.equal(judgeCheckResult(reading).ok, false);
});

test("a check that recorded no items at all cannot pass", () => {
  const result = judgeCheckResult(readJudgeCheck([]));
  assert.equal(result.ok, false);
  assert.match(result.lines.join("\n"), noItemsPattern);
});

test("a problem around the check stops the sweep even when every item matched", () => {
  const result = judgeCheckResult(readJudgeCheck([ok("a"), ok("b")]), [
    "The judge check crashed (exit 1).",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.summary.passed, false);
  assert.match(result.lines.join("\n"), crashedExit1Pattern);
  assert.match(result.lines.join("\n"), didNotFinishPattern);
});

test("the summary the check makes is the shape the sweep summary stores", () => {
  const sweep = parseSweepFile({});
  for (const result of [
    judgeCheckResult(readJudgeCheck([ok("a")])),
    judgeCheckResult(readJudgeCheck([planted("a"), falseAlarm("b")])),
  ]) {
    const summary = assembleSweepSummary({
      actual: { costUsd: 0, hours: 0 },
      estimate: { costUsd: 0, hours: 0 },
      judgeCheck: result.summary,
      reports: [],
      sweep,
      sweepFile: "default.yaml",
      sweepId: "2026-11-10T031500Z-default",
    });
    assert.deepEqual(parseSweepSummary(summary).judgeCheck, result.summary);
  }
});

test("only rows whose person is the judge check count as its rows", () => {
  assert.equal(isJudgeCheckRow(ok("a")), true);
  const sam = itemRow("a", verdict(true));
  sam.metadata.person = "sam";
  assert.equal(isJudgeCheckRow(sam), false);
});

// ---------------------------------------------------------------------------
// Running it, with a fake `eve`
// ---------------------------------------------------------------------------

const rowLine = (id: string, passed: boolean | undefined, extra = {}) =>
  JSON.stringify(itemRow(id, verdict(passed, extra), {}));

const fakeEveScript = `
const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.FAKE_JUDGE_CHECK ?? "pass";
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("SAGE_") || name.startsWith("AI_GATEWAY") || name.startsWith("EVE_"))),
}) + "\\n");
if (mode === "crash") {
  process.exit(2);
}
const rows = JSON.parse(process.env.FAKE_ROWS);
fs.mkdirSync(path.dirname(process.env.SAGE_EVAL_RESULTS), { recursive: true });
for (const row of rows) {
  fs.appendFileSync(process.env.SAGE_EVAL_RESULTS, row + "\\n");
}
process.exit(mode === "miss" ? 1 : 0);
`;

interface Rig {
  agentDir: string;
  calls: string;
  run: Parameters<typeof runJudgeCheck>[0];
  runDir: string;
}

function makeRig(
  t: test.TestContext,
  mode: "crash" | "miss" | "pass",
  rows: string[]
): Rig {
  const dir = tempDir(t);
  const agentDir = join(dir, "agent");
  const runDir = join(dir, "run");
  const calls = join(dir, "calls.jsonl");
  fakeEve(agentDir, fakeEveScript);
  const previous = {
    FAKE_CALLS: process.env.FAKE_CALLS,
    FAKE_JUDGE_CHECK: process.env.FAKE_JUDGE_CHECK,
    FAKE_ROWS: process.env.FAKE_ROWS,
  };
  process.env.FAKE_CALLS = calls;
  process.env.FAKE_JUDGE_CHECK = mode;
  process.env.FAKE_ROWS = JSON.stringify(rows);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  return {
    agentDir,
    calls,
    run: {
      agentDir,
      credentials: { AI_GATEWAY_API_KEY: "gateway-key-0123456789" },
      runDir,
      stubUrl: "http://127.0.0.1:4242",
      sweepFile: join(runDir, "sweep.json"),
      sweepId: "2026-11-10T031500Z-default",
    },
    runDir,
  };
}

function readCall(path: string) {
  return JSON.parse(
    readFileSync(path, "utf8").trim().split("\n")[0] ?? "{}"
  ) as {
    args: string[];
    cwd: string;
    env: Record<string, string>;
  };
}

test("the check runs eve eval on the judge-check folder against the stub target, with the key and no person or setup", async (t) => {
  const rig = makeRig(t, "pass", [
    rowLine("lost-mia-death", true),
    rowLine("clean-run", true),
  ]);
  // Things a shell can leave behind must not reach the check.
  const stray = {
    [EVAL_ENV.manifest]: "/stray/manifest.json",
    [EVAL_ENV.person]: "sam",
    [EVAL_ENV.setupId]: "0123456789",
    [EVAL_ENV.transcripts]: "/stray/transcripts.jsonl",
    [ENV_DREAM_KEY]: "stray-key",
    SAGE_DATA_DIR: "/stray/data",
    SAGE_EVAL_DREAM_PROMPTS: "/stray/prompts",
  };
  const saved = Object.fromEntries(
    Object.keys(stray).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, stray);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const result = await runJudgeCheck(rig.run);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.summary, { misses: [], passed: true });

  const call = readCall(rig.calls);
  assert.deepEqual(call.args, [
    "eval",
    JUDGE_CHECK_EVAL,
    "--max-concurrency",
    "4",
    "--url",
    "http://127.0.0.1:4242",
  ]);
  assert.equal(call.env.AI_GATEWAY_API_KEY, "gateway-key-0123456789");
  const files = judgeCheckFiles(rig.runDir);
  assert.equal(call.env[EVAL_ENV.results], files.results);
  assert.equal(call.env[EVAL_ENV.runDir], rig.runDir);
  assert.equal(call.env[EVAL_ENV.sweepFile], rig.run.sweepFile);
  assert.equal(call.env[ENV_SWEEP_ID], rig.run.sweepId);
  assert.equal(call.env[EVAL_ENV.today], "2026-11-15");
  for (const name of Object.keys(stray)) {
    assert.equal(call.env[name], undefined, name);
  }
  // The rows and the log sit in their own folder of the run directory.
  assert.ok(existsSync(files.dir));
  assert.equal(dirname(files.results), files.dir);
  assert.equal(dirname(files.log), files.dir);
});

test("a miss makes the eve process exit 1, and the check lists it and stops the sweep", async (t) => {
  const rig = makeRig(t, "miss", [
    JSON.stringify(planted("lost-mia-death")),
    JSON.stringify(falseAlarm("clean-run")),
  ]);
  const result = await runJudgeCheck(rig.run);
  assert.equal(result.ok, false);
  assert.equal(result.summary.passed, false);
  assert.deepEqual(
    result.summary.misses.map((miss) => [miss.kind, miss.check, miss.itemId]),
    [
      ["missed", "no-severe-unsupported", "judge-check/dream/lost-mia-death"],
      ["false-alarm", "dream-supported", "judge-check/dream/clean-run"],
    ]
  );
});

test("an item the judge could not grade stops the sweep as unchecked", async (t) => {
  const rig = makeRig(t, "pass", [
    rowLine("lost-mia-death", true),
    rowLine("clean-run", undefined, {
      notGraded: true,
      reason: "not graded: spending cap",
    }),
  ]);
  const result = await runJudgeCheck(rig.run);
  assert.equal(result.ok, false);
  assert.match(result.lines.join("\n"), cannotBeCheckedPattern);
});

test("an eve process that crashes before recording anything stops the sweep", async (t) => {
  const rig = makeRig(t, "crash", []);
  const result = await runJudgeCheck(rig.run);
  assert.equal(result.ok, false);
  const text = result.lines.join("\n");
  assert.match(text, crashPattern);
  assert.match(text, noItemsPattern);
});

test("rows from another person in the check's file are not read as its items", async (t) => {
  const sam = itemRow("elsewhere", verdict(false));
  sam.metadata.person = "sam";
  const rig = makeRig(t, "pass", [
    JSON.stringify(sam),
    rowLine("lost-mia-death", true),
  ]);
  const result = await runJudgeCheck(rig.run);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
});

// ---------------------------------------------------------------------------
// The check under smoke's spending cap
// ---------------------------------------------------------------------------

/**
 * The judge's price in the plan: Kimi K3.1 Pro at $2 in and $10 out per
 * million tokens. The mock judge below bills every prompt token at the full
 * input price, with no cached-input discount, so these totals are an upper
 * bound for what the gateway bills.
 */
const KIMI_PRICE = { inputPerM: 2, outputPerM: 10 };
const DREAM_ANSWER_TOKENS = 600;

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
function cleanAnswerFor(text: string): string {
  if (!text.includes("Checks to answer:")) {
    return JSON.stringify({ unsupportedClaims: [] });
  }
  const block = text.slice(text.lastIndexOf("Checks to answer:"));
  const passing = (askId: string) => ({
    evidence: "",
    id: askId,
    pass: true,
    reason: "",
  });
  const na = block.includes("N/A, answer with level null")
    ? block.slice(block.indexOf("N/A, answer with level null"))
    : "";
  return JSON.stringify({
    counted: idsAfter(block, "counted").map(passing),
    hard: idsAfter(block, "hard").map(passing),
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

/** A judge that answers after a short wait and bills the prompt's tokens plus `replyTokens` for a reply grade. */
function mockJudge(replyTokens: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      const output = text.includes("Checks to answer:")
        ? replyTokens
        : DREAM_ANSWER_TOKENS;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const input = Math.round(text.length / 4);
      return {
        content: [{ text: cleanAnswerFor(text), type: "text" as const }],
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

function outcomeOf(
  id: string,
  result: { ok: true } | { ok: false; reason: string }
): Outcome {
  return result.ok
    ? { id, ok: true }
    : { id, ok: false, reason: result.reason };
}

/** Every item of the judge check, Dream half then reply half, through one grader. */
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
    ...dream.map(
      (item) => async () =>
        outcomeOf(item.id, await gradeCheckItem(grader, item))
    ),
    ...replies.map(
      (resolved) => async () =>
        outcomeOf(resolved.item.id, await gradeReplyCheckItem(grader, resolved))
    ),
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
  return items.map(
    ({ id, item, message }) =>
      async () =>
        outcomeOf(
          id,
          await gradeReply(grader, {
            context,
            item,
            label: `reply ${id}`,
            message,
            reply:
              "That sounds like a lot to carry. What feels heaviest right now?",
            toolCalls: [],
          })
        )
  );
}

async function smokeGrader(t: test.TestContext, replyTokens: number) {
  const { sweep } = await loadSweep("smoke", {});
  const runDir = join(tempDir(t, "sage-smoke-cap-"), "run");
  const grader = createGrader({
    capUsd: sweep.spendingCapUsd,
    model: mockJudge(replyTokens),
    modelId: sweep.judge.model,
    price: KIMI_PRICE,
    runDir,
    sweepId: "smoke-cap",
  });
  return { grader, runDir, sweep };
}

test("smoke.yaml's spending cap leaves room for the whole judge check", async (t) => {
  const { grader, runDir, sweep } = await smokeGrader(t, 1500);
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
  assert.ok(totals(runDir).spentUsd < sweep.spendingCapUsd * 0.75);
});

test("smoke.yaml's spending cap also covers smoke's own reply grades, at 1000 or 1500 output tokens a reply", async (t) => {
  for (const replyTokens of [1000, 1500]) {
    // biome-ignore lint/performance/noAwaitInLoops: each size is its own run with its own ledger
    const { grader, runDir, sweep } = await smokeGrader(t, replyTokens);
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
      `${replyTokens} tokens: spent $${totals(runDir).spentUsd.toFixed(2)} of $${sweep.spendingCapUsd}`
    );
    assert.ok(replies.length > 0);
  }
});

test("a reply grade reserves about what it expects to spend, not the output cap", async (t) => {
  const { grader, runDir } = await smokeGrader(t, 1500);
  const [first] = await smokeReplyTasks(grader);
  assert.ok(first);
  const outcome = await first();
  assert.equal(outcome.ok, true);
  const { reservedUsd, spentUsd } = totals(runDir);
  // Settled, so nothing stays reserved, and the call cost a few cents.
  assert.equal(reservedUsd, 0);
  assert.ok(spentUsd > 0 && spentUsd < 0.1, `$${spentUsd}`);
});

test("judgeCheckSize counts the Dream and reply items the check grades", async () => {
  const size = await judgeCheckSize();
  assert.equal(size.dreamItems, (await loadDreamCheckItems()).length);
  assert.equal(size.replyItems, (await loadReplyCheckItems()).length);
  assert.ok(size.dreamItems > 0 && size.replyItems > 0);
});
