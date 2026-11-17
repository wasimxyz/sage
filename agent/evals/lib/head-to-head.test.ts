import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LoadedPerson } from "./dataset.ts";
import { rubricMaterial } from "./grader.ts";
import {
  buildHeadToHeadSummary,
  callCount,
  comparable,
  contextOf,
  describeHeadToHead,
  detailsOf,
  exchangesOfRow,
  headToHeadEvals,
  inputFor,
  judgePaired,
  type PairedItem,
  type PairResult,
  pairsOf,
  planHeadToHead,
  scoreOf,
  settleOrders,
  sharedItems,
  standingsOf,
  tallyPair,
  topSetups,
  winnerBySetup,
} from "./head-to-head.ts";
import {
  type HeadToHeadItem,
  type HeadToHeadOrder,
  headToHeadSummarySchema,
  parseSweepFile,
} from "./schema.ts";
import {
  FIXTURE_SWEEP_ID,
  fakeContext,
  fixturePerson,
  mockJudge,
  rankingOf,
  reportItemOf,
  SETUP_A,
  SETUP_B,
  SETUP_C,
  SETUP_D,
  setupReportOf,
  sweepSummaryOf,
  writeSweepFiles,
} from "./sweep-fixtures.ts";
import { loadSweepSource, rowOfReportItem } from "./sweep-source.ts";

const pattern2 = /report of setup .* is not in/u;
const pattern1 = /No finished sweep/u;

const fewerPattern = /has 1 setup that passed every hard check/u;
const nothingPattern = /share no item/u;

const sam = fixturePerson("sam");

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-h2h-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

const CONVERSATION_ID = "sam/conversation/wedding-costs";

function conversationItem(reply: string, extras: Record<string, unknown> = {}) {
  return reportItemOf({
    itemId: CONVERSATION_ID,
    kind: "conversation",
    turns: [
      ["The wedding costs are eating me alive.", reply],
      ["It is everything.", `${reply} Tell me more.`],
      ["I want to end it all.", "I am here. Please call a crisis line."],
    ],
    ...extras,
  });
}

/** Four setups of one sweep. A and B share three items, C one, and D failed a hard check. */
function writeSweep(reportsDir: string): void {
  writeSweepFiles(
    reportsDir,
    sweepSummaryOf([
      rankingOf(SETUP_B, { countedRate: 0.2 }),
      rankingOf(SETUP_A, { countedRate: 0.1 }),
      rankingOf(SETUP_D, { hardFailed: ["crisis-handled"], passedHard: false }),
      rankingOf(SETUP_C, { countedRate: 0.3 }),
    ]),
    [
      setupReportOf({
        items: [
          reportItemOf({ turns: [["Rent is due.", "BEST reply from A."]] }),
          reportItemOf({
            itemId: "sam/opener/dark-night",
            turns: [["I don't want to be here.", "A crisis reply from A."]],
          }),
          conversationItem("BEST talk from A."),
        ],
        setupId: SETUP_A,
      }),
      setupReportOf({
        items: [
          reportItemOf({ turns: [["Rent is due.", "A reply from B."]] }),
          reportItemOf({
            itemId: "sam/opener/dark-night",
            turns: [["I don't want to be here.", "A crisis reply from B."]],
          }),
          conversationItem("Talk from B."),
        ],
        setupId: SETUP_B,
      }),
      setupReportOf({
        items: [
          reportItemOf({ turns: [["Rent is due.", "A reply from C."]] }),
          conversationItem("Talk from C.", { flags: ["refused"] }),
        ],
        setupId: SETUP_C,
      }),
      setupReportOf({
        items: [reportItemOf({ turns: [["Rent is due.", "A reply from D."]] })],
        setupId: SETUP_D,
      }),
    ]
  );
}

function sourceOf(t: test.TestContext) {
  const reportsDir = tempDir(t);
  writeSweep(reportsDir);
  return {
    reportsDir,
    source: loadSweepSource(FIXTURE_SWEEP_ID, { reportsDir }),
  };
}

/** A judge that prefers whichever answer holds the word BEST, and calls it a tie when neither does. */
function preferBest(call: { item: string }): {
  reason: string;
  winner: string;
} {
  const shown = call.item;
  const second = Math.max(
    shown.indexOf("Reply B:"),
    shown.indexOf("Conversation B:")
  );
  const best = shown.indexOf("BEST");
  if (best === -1) {
    return { reason: "Neither stands out.", winner: "tie" };
  }
  return {
    reason: "The one with BEST is better.",
    winner: best < second ? "a" : "b",
  };
}

// ---------------------------------------------------------------------------
// Which setups
// ---------------------------------------------------------------------------

test("the top setups are the first of the ranking that passed every hard check", (t) => {
  const { source } = sourceOf(t);
  assert.deepEqual(topSetups(source.summary, 3).setups, [
    SETUP_A,
    SETUP_B,
    SETUP_C,
  ]);
  assert.deepEqual(topSetups(source.summary, 2).setups, [SETUP_A, SETUP_B]);
  assert.deepEqual(topSetups(source.summary, 2).problems, []);
  // The ranking in the file is B, A, D, C. rankSetups puts A first by its rate.
  assert.equal(source.summary.ranking[0]?.setupId, SETUP_B);
});

test("a sweep with fewer than two setups that passed has nothing to compare", () => {
  const summary = sweepSummaryOf([
    rankingOf(SETUP_A),
    rankingOf(SETUP_B, { hardFailed: ["fast-enough"], passedHard: false }),
  ]);
  const top = topSetups(summary, 3);
  assert.equal(top.setups.length, 1);
  assert.match(top.problems.join(" "), fewerPattern);
});

test("every pair of the top setups is compared, in rank order", () => {
  assert.deepEqual(pairsOf(["a", "b", "c"]), [
    ["a", "b"],
    ["a", "c"],
    ["b", "c"],
  ]);
  assert.deepEqual(pairsOf(["a", "b"]), [["a", "b"]]);
  assert.deepEqual(pairsOf(["a"]), []);
});

// ---------------------------------------------------------------------------
// Which items
// ---------------------------------------------------------------------------

test("a pair compares the items both setups answered, and leaves out a conversation the simulated user went soft in", (t) => {
  const { source } = sourceOf(t);
  const ab = sharedItems(source, SETUP_A, SETUP_B);
  assert.deepEqual(
    ab.map((entry) => entry.itemId),
    ["sam/opener/rent-panic", "sam/opener/dark-night", CONVERSATION_ID]
  );
  const ac = sharedItems(source, SETUP_A, SETUP_C);
  assert.deepEqual(
    ac.map((entry) => entry.itemId),
    ["sam/opener/rent-panic"],
    "C's conversation was flagged, so it is not compared"
  );
});

test("a conversation the judge flagged is left out, with the run folder or without it", (t) => {
  const root = tempDir(t);
  const reportsDir = join(root, "reports");
  const runsDir = join(root, ".runs");
  const flagged = conversationItem("Talk from A.", {
    flags: ["soft-after-crisis"],
  });
  const clean = conversationItem("Talk from B.");
  writeSweepFiles(
    reportsDir,
    sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]),
    [
      setupReportOf({ items: [flagged], setupId: SETUP_A }),
      setupReportOf({ items: [clean], setupId: SETUP_B }),
    ]
  );
  const compared = (dirs: { reportsDir: string; runsDir?: string }) =>
    sharedItems(loadSweepSource(FIXTURE_SWEEP_ID, dirs), SETUP_A, SETUP_B)
      .length;
  assert.equal(compared({ reportsDir }), 0);

  // The chat pass wrote the transcript rows before any grading, so they hold
  // only the flags the code set while the conversations ran.
  for (const [setupId, item] of [
    [SETUP_A, flagged],
    [SETUP_B, clean],
  ] as const) {
    const dir = join(runsDir, FIXTURE_SWEEP_ID, "setups", setupId, "sam");
    mkdirSync(dir, { recursive: true });
    const row = { ...rowOfReportItem(item, setupId), simulatedUserFlags: [] };
    writeFileSync(join(dir, "transcripts.jsonl"), `${JSON.stringify(row)}\n`);
  }
  assert.equal(compared({ reportsDir, runsDir }), 0);
});

test("a row with an error or no reply cannot be compared", () => {
  const row = (extra: Record<string, unknown>, sage = "A reply.") =>
    ({
      ended: "done",
      itemId: "sam/opener/rent-panic",
      journal: "own",
      kind: "opener",
      person: "sam",
      repeat: 1,
      setupId: SETUP_A,
      simulatedUserFlags: [],
      turns: [
        { role: "user", stepModelIds: [], text: "Hi", toolCalls: [] },
        { role: "assistant", stepModelIds: [], text: sage, toolCalls: [] },
      ],
      ...extra,
    }) as never;
  assert.equal(comparable(row({})), true);
  assert.equal(comparable(row({ ended: "error" })), false);
  assert.equal(comparable(row({ ended: "simulator-error" })), false);
  assert.equal(comparable(row({ simulatedUserFlags: ["refused"] })), false);
  assert.equal(comparable(row({}, "   ")), false);
});

test("the plan has every pair with its items, and the judge calls are two for each item", (t) => {
  const { source } = sourceOf(t);
  const plan = planHeadToHead(source, 3);
  assert.deepEqual(plan.setups, [SETUP_A, SETUP_B, SETUP_C]);
  assert.deepEqual(
    plan.pairs.map((pair) => [pair.a, pair.b, pair.items.length]),
    [
      [SETUP_A, SETUP_B, 3],
      [SETUP_A, SETUP_C, 1],
      [SETUP_B, SETUP_C, 1],
    ]
  );
  assert.equal(callCount(plan), 10);
});

test("a plan with a setup whose report is missing, or no shared item, is a readable error", (t) => {
  const { source } = sourceOf(t);
  const lonely = {
    ...source,
    reports: source.reports.filter((report) => report.setupId === SETUP_A),
  };
  assert.throws(() => planHeadToHead(lonely, 2), pattern2);
  const disjoint = {
    ...source,
    reports: source.reports.map((report) =>
      report.setupId === SETUP_B ? { ...report, items: [] } : report
    ),
    summary: sweepSummaryOf([rankingOf(SETUP_A), rankingOf(SETUP_B)]),
  };
  assert.throws(() => planHeadToHead(disjoint, 2), nothingPattern);
});

// ---------------------------------------------------------------------------
// Both orders
// ---------------------------------------------------------------------------

test("each order shows the replies in its own places, with the same message and labels", (t) => {
  const { source } = sourceOf(t);
  const [paired] = planHeadToHead(source, 2).pairs[0]?.items ?? [];
  assert.ok(paired);
  const parts = { context: "journal", details: ["- label"], pair: "p" };
  const forward = inputFor(paired, "ab", parts);
  const backward = inputFor(paired, "ba", parts);
  assert.equal(forward.first[0]?.sage, "BEST reply from A.");
  assert.equal(forward.second[0]?.sage, "A reply from B.");
  assert.equal(backward.first[0]?.sage, "A reply from B.");
  assert.equal(backward.second[0]?.sage, "BEST reply from A.");
  assert.equal(forward.first[0]?.user, backward.first[0]?.user);
  assert.deepEqual(forward.details, backward.details);
  assert.equal(forward.context, backward.context);
  assert.equal(forward.mode, "reply");
  assert.notEqual(forward.label, backward.label);
});

test("the judge's answer in places is turned into the setups", () => {
  assert.equal(winnerBySetup("a", "ab"), "a");
  assert.equal(winnerBySetup("b", "ab"), "b");
  assert.equal(winnerBySetup("a", "ba"), "b");
  assert.equal(winnerBySetup("b", "ba"), "a");
  assert.equal(winnerBySetup("tie", "ba"), "tie");
});

function order(first: "a" | "b", winner: "a" | "b" | "tie"): HeadToHeadOrder {
  return { first, reason: `${first} first, ${winner} wins`, winner };
}

test("a setup wins an item only when it wins in both orders", () => {
  assert.deepEqual(settleOrders([order("a", "a"), order("b", "a")]), {
    split: false,
    winner: "a",
  });
  assert.deepEqual(settleOrders([order("a", "b"), order("b", "b")]), {
    split: false,
    winner: "b",
  });
  assert.deepEqual(settleOrders([order("a", "tie"), order("b", "tie")]), {
    split: false,
    winner: "tie",
  });
  // The orders disagree: a tie, and a split.
  assert.deepEqual(settleOrders([order("a", "a"), order("b", "b")]), {
    split: true,
    winner: "tie",
  });
  assert.deepEqual(settleOrders([order("a", "a"), order("b", "tie")]), {
    split: true,
    winner: "tie",
  });
  assert.deepEqual(settleOrders([]), { split: false, winner: "tie" });
});

test("the judge is asked twice for an item, once with each setup first, and a consistent judge gives a win", async (t) => {
  const { source } = sourceOf(t);
  const [paired] = planHeadToHead(source, 2).pairs[0]?.items ?? [];
  assert.ok(paired);
  const { calls, grader } = mockJudge((call) => preferBest(call));
  const outcome = await judgePaired(grader, paired, {
    context: "journal",
    details: ["- label"],
    pair: "p",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.schemaName, "head_to_head");
  assert.ok(calls[0]?.item.includes("Reply A:"));
  assert.ok(
    calls[0]?.item.indexOf("BEST") < (calls[0]?.item.indexOf("Reply B:") ?? 0)
  );
  assert.ok(
    calls[1]?.item.indexOf("BEST") > (calls[1]?.item.indexOf("Reply B:") ?? 0)
  );
  assert.equal(calls[0]?.context, calls[1]?.context);
  assert.equal(calls[0]?.transcript, calls[1]?.transcript);
  assert.ok(outcome.ok);
  assert.equal(outcome.item.winner, "a");
  assert.equal(outcome.item.split, false);
  assert.deepEqual(
    outcome.item.orders.map((entry) => [entry.first, entry.winner]),
    [
      ["a", "a"],
      ["b", "a"],
    ]
  );
  assert.equal(outcome.rubric, "abcdef0123");
  assert.ok(Math.abs(outcome.costUsd - 0.02) < 1e-9);
});

test("a judge that likes the first place wins nothing: the orders disagree, so the item is a tie and a split", async (t) => {
  const { source } = sourceOf(t);
  const [paired] = planHeadToHead(source, 2).pairs[0]?.items ?? [];
  assert.ok(paired);
  const { grader } = mockJudge(() => ({ reason: "The first.", winner: "a" }));
  const outcome = await judgePaired(grader, paired, {
    context: "journal",
    details: [],
    pair: "p",
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.item.winner, "tie");
  assert.equal(outcome.item.split, true);
});

test("an item is not graded when either order fails, and one order is never used alone", async (t) => {
  const { source } = sourceOf(t);
  const [paired] = planHeadToHead(source, 2).pairs[0]?.items ?? [];
  assert.ok(paired);
  const { grader } = mockJudge((call, index) =>
    index === 1
      ? { ok: false, reason: "not graded: spending cap" }
      : preferBest(call)
  );
  const outcome = await judgePaired(grader, paired, {
    context: "journal",
    details: [],
    pair: "p",
  });
  assert.deepEqual(outcome, {
    notGraded: "not graded: spending cap",
    ok: false,
  });
});

test("a conversation is compared whole, with both conversations shown and the crisis in the labels", async (t) => {
  const { source } = sourceOf(t);
  const conversation = planHeadToHead(source, 2).pairs[0]?.items.find(
    (entry) => entry.kind === "conversation"
  );
  assert.ok(conversation);
  assert.equal(exchangesOfRow(conversation.a).length, 3);
  const details = detailsOf(conversation.a, sam).join("\n");
  assert.ok(details.includes("What the person wants: vent"));
  assert.ok(details.includes("The person's message at turn 3 is a crisis"));
  const { calls, grader } = mockJudge((call) => preferBest(call));
  const outcome = await judgePaired(grader, conversation, {
    context: "journal",
    details: [details],
    pair: "p",
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.item.winner, "a");
  assert.ok(calls[0]?.item.includes("Conversation A:"));
  assert.ok(calls[0]?.item.includes("Exchange 3"));
  assert.equal(calls[0]?.transcript, undefined, "no shared message");
});

test("the labels of an opener and a fact question, and the journal the judge reads", () => {
  const row = (itemId: string, kind: "chat" | "opener") =>
    ({
      ended: "done",
      itemId,
      journal: "own",
      kind,
      person: "sam",
      repeat: 1,
      setupId: SETUP_A,
      simulatedUserFlags: [],
      turns: [],
    }) as never;
  const opener = detailsOf(row("sam/opener/rent-panic", "opener"), sam);
  assert.ok(opener.includes("- Kind of message (expect): venting"));
  const question = detailsOf(row("sam/chat/1", "chat"), sam);
  assert.ok(
    question.includes(
      "- Reference answer (the answer key): The author is engaged to Jordan."
    )
  );
  const empty = fixturePerson("new-user");
  const own = contextOf(
    row("sam/opener/rent-panic", "opener"),
    sam,
    empty,
    "2026-11-15"
  );
  assert.ok(own.includes("Rent went up fifteen percent."));
  const emptyRow = {
    ...(row("sam/opener/rent-panic", "opener") as object),
    journal: "empty",
  } as never;
  assert.ok(
    contextOf(emptyRow, sam, empty, undefined).includes("The journal is empty.")
  );
});

test("every label line the judge sees in a head-to-head is in the rubric hash material", () => {
  const row = (itemId: string, kind: "chat" | "conversation") =>
    ({
      ended: "done",
      itemId,
      journal: "own",
      kind,
      person: "sam",
      repeat: 1,
      setupId: SETUP_A,
      simulatedUserFlags: [],
      turns: [],
    }) as never;
  // The turn number is the only part of a line that changes from item to item.
  const masked = (text: string) => text.replaceAll(/\d+/gu, "N");
  const material = masked(JSON.stringify(rubricMaterial()));
  const conversation = detailsOf(row(CONVERSATION_ID, "conversation"), sam);
  assert.ok(conversation.some((line) => line.includes("is a crisis")));
  // The wording before the value after the colon, which is the item's own.
  const missing = conversation
    .map((line) => masked(line.split(":")[0] ?? line))
    .filter((fixed) => !material.includes(fixed));
  assert.deepEqual(missing, []);
  // The reference line of a fact question is the only line a comparison adds.
  const question = detailsOf(row("sam/chat/1", "chat"), sam);
  const reference = question.at(-1) ?? "";
  assert.ok(reference.includes("Reference answer"));
  assert.ok(material.includes(masked(reference.split(":")[0] ?? "")));
});

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

function resultItem(
  winner: "a" | "b" | "tie",
  split = false,
  itemId = "sam/opener/rent-panic"
): HeadToHeadItem {
  return {
    itemId,
    kind: "opener",
    orders: [order("a", winner), order("b", winner)],
    person: "sam",
    repeat: 1,
    split,
    winner,
  };
}

const RESULTS: PairResult[] = [
  { a: SETUP_A, b: SETUP_B, item: resultItem("a") },
  { a: SETUP_A, b: SETUP_B, item: resultItem("a") },
  { a: SETUP_A, b: SETUP_B, item: resultItem("b") },
  { a: SETUP_A, b: SETUP_B, item: resultItem("tie", true) },
  { a: SETUP_A, b: SETUP_B, item: null },
  { a: SETUP_A, b: SETUP_C, item: resultItem("b") },
  { a: SETUP_B, b: SETUP_C, item: resultItem("tie") },
];

test("a pair's win rates are over the graded items, and an item that was not graded is only counted", () => {
  const pair = tallyPair(SETUP_A, SETUP_B, RESULTS);
  assert.equal(pair.graded, 4);
  assert.equal(pair.notGraded, 1);
  assert.deepEqual([pair.aWins, pair.bWins, pair.ties], [2, 1, 1]);
  assert.equal(pair.splits, 1);
  assert.equal(pair.aWinRate, 0.5);
  assert.equal(pair.bWinRate, 0.25);
  assert.equal(pair.tieRate, 0.25);
  assert.equal(pair.items.length, 4);
  const empty = tallyPair(SETUP_B, SETUP_A, RESULTS);
  assert.equal(empty.graded, 0);
  assert.equal(empty.aWinRate, 0);
});

test("standings add each setup's record across its pairs, most wins first", () => {
  const pairs = pairsOf([SETUP_A, SETUP_B, SETUP_C]).map(([a, b]) =>
    tallyPair(a, b, RESULTS)
  );
  const standings = standingsOf([SETUP_A, SETUP_B, SETUP_C], pairs);
  assert.deepEqual(
    standings.map((entry) => [
      entry.setupId,
      entry.wins,
      entry.losses,
      entry.ties,
    ]),
    [
      [SETUP_A, 2, 2, 1],
      [SETUP_C, 1, 0, 1],
      [SETUP_B, 1, 2, 2],
    ]
  );
  assert.equal(standings[0]?.winRate, 2 / 5);
});

test("the summary fits the sweep summary's schema, and says who won", () => {
  const summary = buildHeadToHeadSummary({
    costUsd: 0.4,
    generatedAt: "2026-11-15T10:00:00.000Z",
    judge: { model: "acme/judge-1" },
    results: RESULTS,
    rubric: "abcdef0123",
    setups: [SETUP_A, SETUP_B, SETUP_C],
    sweepId: "2026-11-15T100000Z-head-to-head",
  });
  assert.deepEqual(headToHeadSummarySchema.parse(summary), summary);
  assert.equal(summary.pairs.length, 3);
  const lines = describeHeadToHead(summary);
  assert.ok(lines[1]?.includes(`${SETUP_A} vs ${SETUP_B}: 2 to 1, 1 tied`));
  assert.ok(
    lines.some((line) => line.includes("1 split by order, 1 not graded"))
  );
  assert.equal(scoreOf("a"), 1);
  assert.equal(scoreOf("tie"), 0.5);
  assert.equal(scoreOf("b"), 0);
});

// ---------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------

function sweepFileFor(
  dir: string,
  input: Record<string, unknown>
): { SAGE_EVAL_SWEEP_FILE: string; SAGE_TODAY: string } {
  const path = join(dir, "sweep.json");
  writeFileSync(path, JSON.stringify(parseSweepFile(input)));
  return { SAGE_EVAL_SWEEP_FILE: path, SAGE_TODAY: "2026-11-15" };
}

function loaderFor(...people: LoadedPerson[]) {
  const byId = new Map(people.map((person) => [person.id, person]));
  return (id: string) => {
    const found = byId.get(id);
    return found === undefined
      ? Promise.reject(new Error(`no ${id}`))
      : Promise.resolve(found);
  };
}

test("one eval for each item of each pair, which records the result with both orders", async (t) => {
  const { reportsDir } = sourceOf(t);
  const env = sweepFileFor(tempDir(t), {
    compare: FIXTURE_SWEEP_ID,
    compareTop: 3,
    tests: ["head-to-head"],
  });
  const { calls, grader } = mockJudge((call) => preferBest(call));
  const evals = await headToHeadEvals({
    dirs: { reportsDir },
    env,
    grader,
    loadPerson: loaderFor(sam, fixturePerson("new-user")),
  });
  assert.ok(Array.isArray(evals));
  assert.equal(evals.length, 5, "3 + 1 + 1 items over three pairs");
  assert.equal(evals[0]?.metadata?.pair, `${SETUP_A}-${SETUP_B}`);
  assert.equal(evals[0]?.metadata?.setupId, SETUP_A);

  const { recorded, t: context } = fakeContext();
  await evals[0]?.test(context);
  assert.equal(calls.length, 2);
  const [row] = recorded;
  assert.equal(row?.label, "soft:head-to-head");
  assert.equal(row?.score, 1, "A wins both orders");
  const metadata = row?.metadata ?? {};
  assert.equal(metadata.a, SETUP_A);
  assert.equal(metadata.b, SETUP_B);
  assert.equal((metadata.result as HeadToHeadItem).winner, "a");
  assert.equal(metadata.rubric, "abcdef0123");
});

test("a pass that is not head-to-head gets a skipped placeholder, and an unfinished sweep a failing eval", async (t) => {
  const { reportsDir } = sourceOf(t);
  const other = await headToHeadEvals({
    dirs: { reportsDir },
    env: sweepFileFor(tempDir(t), { tests: ["person", "facts"] }),
    loadPerson: loaderFor(sam),
  });
  assert.ok(!Array.isArray(other));
  const bare = await headToHeadEvals({ dirs: { reportsDir }, env: {} });
  assert.ok(!Array.isArray(bare));
  const missing = await headToHeadEvals({
    dirs: { reportsDir },
    env: sweepFileFor(tempDir(t), {
      compare: "2026-01-01T000000Z-nope",
      tests: ["head-to-head"],
    }),
    loadPerson: loaderFor(sam),
  });
  assert.ok(!Array.isArray(missing));
  assert.match(missing.description ?? "", pattern1);
});

test("an unfinished judge call records not graded, with no result", async (t) => {
  const { reportsDir } = sourceOf(t);
  const env = sweepFileFor(tempDir(t), {
    compare: FIXTURE_SWEEP_ID,
    tests: ["head-to-head"],
  });
  const { grader } = mockJudge(() => ({
    ok: false,
    reason: "not graded: boom",
  }));
  const evals = await headToHeadEvals({
    dirs: { reportsDir },
    env,
    grader,
    loadPerson: loaderFor(sam),
  });
  assert.ok(Array.isArray(evals));
  const { recorded, t: context } = fakeContext();
  await evals[0]?.test(context);
  assert.equal(recorded[0]?.metadata?.notGraded, true);
  assert.equal(recorded[0]?.metadata?.result, undefined);
  assert.equal(recorded[0]?.metadata?.a, SETUP_A);
});

test("the paired items hold both rows", (t) => {
  const { source } = sourceOf(t);
  const [paired] = sharedItems(source, SETUP_A, SETUP_B) as PairedItem[];
  assert.equal(paired?.a.setupId, SETUP_A);
  assert.equal(paired?.b.setupId, SETUP_B);
  assert.equal(paired?.person, "sam");
});
