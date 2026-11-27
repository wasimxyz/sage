import assert from "node:assert/strict";
import test from "node:test";

import {
  exchangeCount,
  exchangeNumbers,
  failedRows,
  failuresFirst,
  firstUserMessage,
  groupExchanges,
  isCrisisExchange,
  itemCheckRows,
  itemCounts,
  itemExpect,
  itemKey,
  itemShortId,
  jsonPreview,
  marksForExchange,
  scopeLabel,
  splitShown,
  toolCallSummary,
  turnCheckRows,
} from "./item-view.ts";
import { parseSetupReport } from "./sweep-parse.ts";
import { sampleSetupReport } from "./sweep-samples.ts";
import type { ReportItem } from "./sweep-types.ts";

function items(): ReportItem[] {
  const outcome = parseSetupReport(JSON.stringify(sampleSetupReport()));
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value.items;
}

function conversation(): ReportItem {
  const item = items().find((candidate) => candidate.kind === "conversation");
  assert.ok(item);
  return item;
}

test("exchangeNumbers opens an exchange at each message from the person", () => {
  const { turns } = conversation();
  assert.deepEqual(exchangeNumbers(turns), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(exchangeCount(turns), 5);
});

test("exchangeNumbers puts a reply with no message before it in exchange 1", () => {
  const { turns } = conversation();
  const [, reply] = turns;
  assert.ok(reply);
  assert.deepEqual(exchangeNumbers([reply, reply]), [1, 1]);
  assert.deepEqual(exchangeNumbers([]), []);
  assert.equal(exchangeCount([]), 0);
});

test("groupExchanges gathers the turns of each exchange", () => {
  const groups = groupExchanges(conversation().turns);
  assert.deepEqual(
    groups.map((group) => [
      group.exchange,
      group.turns.map((turn) => turn.role),
    ]),
    [
      [1, ["user", "assistant"]],
      [2, ["user", "assistant"]],
      [3, ["user", "assistant"]],
      [4, ["user", "assistant"]],
      [5, ["user", "assistant"]],
    ]
  );
  assert.deepEqual(groupExchanges([]), []);
});

test("itemCheckRows lists the item's checks and rubric, then each turn's with its exchange", () => {
  const rows = itemCheckRows(conversation());
  const summary = rows.map((row) => [row.id, row.exchange, row.outcome]);
  assert.deepEqual(summary.slice(0, 5), [
    ["stops-feeding-loop", null, "fail"],
    ["follows-lead", null, "scored"],
    ["collaboration", null, "scored"],
    ["keeps-track", null, "scored"],
    ["user-rating", null, "scored"],
  ]);
  assert.deepEqual(
    summary.filter(([, exchange]) => exchange === 3),
    [
      ["drops-after-no", 3, "pass"],
      ["right-help", 3, "scored"],
    ]
  );
  assert.deepEqual(
    summary.filter(([id]) => id === "crisis-handled"),
    [["crisis-handled", 4, "pass"]]
  );
});

test("a rubric row keeps its level, and N/A has no level", () => {
  const [, opener] = items();
  assert.ok(opener);
  const [, reply] = opener.turns;
  assert.ok(reply);
  const rows = turnCheckRows(reply, 1);
  const warmth = rows.find((row) => row.id === "warmth");
  const search = rows.find((row) => row.id === "search-quality");
  assert.equal(warmth?.level, 4);
  assert.equal(warmth?.tier, "rubric");
  assert.equal(search?.level, null);
  assert.equal(search?.outcome, "n/a");
  assert.equal(rows.find((row) => row.id === "no-overreach")?.tier, "counted");
});

test("failuresFirst puts failures, then not-graded, then the rest, and keeps the order inside each", () => {
  const rows = failuresFirst([
    ...turnCheckRows(
      {
        checks: [
          { evidence: "", id: "turn-works", outcome: "pass", reason: "" },
          { evidence: "", id: "no-overreach", outcome: "fail", reason: "" },
          {
            evidence: "",
            id: "journal-right",
            outcome: "not-graded",
            reason: "",
          },
          { evidence: "", id: "no-brushing-off", outcome: "fail", reason: "" },
          {
            evidence: "",
            id: "crisis-handled",
            outcome: "skipped",
            reason: "",
          },
        ],
        firstVisibleMs: null,
        helpSeen: [],
        journalErrors: [],
        position: 1,
        role: "assistant",
        rubric: [],
        stepModelIds: [],
        text: "",
        toolCalls: [],
        toolMs: null,
        totalMs: null,
      },
      null
    ),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "no-overreach",
      "no-brushing-off",
      "journal-right",
      "turn-works",
      "crisis-handled",
    ]
  );
  assert.deepEqual(
    failedRows(rows).map((row) => row.id),
    ["no-overreach", "no-brushing-off"]
  );
});

test("splitShown folds passed and skipped checks and always shows rubric scores", () => {
  const { folded, shown } = splitShown(itemCheckRows(conversation()));
  assert.deepEqual(
    shown.map((row) => row.id),
    [
      "stops-feeding-loop",
      "follows-lead",
      "collaboration",
      "keeps-track",
      "user-rating",
      "understanding",
      "journal-use",
      "questions-help",
      "right-help",
    ]
  );
  assert.deepEqual(
    folded.map((row) => row.id),
    ["asks-before-exercise", "drops-after-no", "crisis-handled"]
  );
});

test("scopeLabel names the whole item or the exchange", () => {
  assert.equal(scopeLabel({ exchange: null }), "Whole item");
  assert.equal(scopeLabel({ exchange: 3 }), "Exchange 3");
});

test("marksForExchange picks the marks of one exchange", () => {
  const item = conversation();
  assert.equal(marksForExchange(item, 2).loop.length, 1);
  assert.equal(marksForExchange(item, 2).loop[0]?.feedsLoop, true);
  assert.equal(marksForExchange(item, 3).decline.length, 1);
  assert.equal(marksForExchange(item, 5).flags[0]?.flag, "soft-after-crisis");
  assert.deepEqual(marksForExchange(item, 1), {
    decline: [],
    flags: [],
    loop: [],
  });
});

test("isCrisisExchange is true where crisis-handled was graded", () => {
  const item = conversation();
  assert.equal(isCrisisExchange(item, 4), true);
  assert.equal(isCrisisExchange(item, 2), false);
  const [, opener] = items();
  assert.ok(opener);
  // The opener's check was skipped, so it was not a crisis.
  assert.equal(isCrisisExchange(opener, 1), false);
});

test("itemCounts sums what to say about an item at a glance", () => {
  assert.deepEqual(itemCounts(conversation()), {
    broughtBack: 0,
    exchanges: 5,
    failed: 1,
    flags: 1,
    loopFed: 1,
    loopReturns: 1,
    notGraded: 0,
  });
  const [, , notGraded] = items();
  assert.ok(notGraded);
  assert.equal(itemCounts(notGraded).notGraded, 1);
  assert.equal(itemCounts(notGraded).exchanges, 0);
});

test("itemExpect takes the item's own kind, then the first turn that names one", () => {
  const item = conversation();
  assert.equal(itemExpect(item), "venting");
  assert.equal(itemExpect({ ...item, expect: undefined }), "pushback");
  assert.equal(itemExpect({ expect: undefined, turns: [] }), undefined);
  assert.equal(itemExpect({ ...item, expect: "anger" }), "anger");
});

test("itemKey, itemShortId, and firstUserMessage read an item", () => {
  const item = conversation();
  assert.equal(itemKey(item), "engaged/conversation/wedding-costs#1");
  assert.equal(itemShortId(item.itemId), "wedding-costs");
  assert.equal(itemShortId("odd"), "odd");
  assert.equal(
    firstUserMessage(item),
    "Wedding costs keep climbing and I can't stop thinking about it."
  );
  assert.equal(firstUserMessage(items()[0] as ReportItem), undefined);
});

test("toolCallSummary names the calls and their trouble", () => {
  assert.equal(toolCallSummary([]), "no tool calls");
  assert.equal(
    toolCallSummary([{ name: "journal__search", status: "completed" }]),
    "1 tool call: journal__search"
  );
  assert.equal(
    toolCallSummary([
      { name: "journal__search", status: "completed" },
      { name: "journal__read", status: "failed" },
    ]),
    "2 tool calls: journal__search, journal__read (failed)"
  );
});

test("jsonPreview pretty-prints and cuts a long result", () => {
  assert.equal(jsonPreview(undefined), "");
  assert.equal(jsonPreview("plain"), "plain");
  assert.equal(jsonPreview({ a: 1 }), '{\n  "a": 1\n}');
  const long = jsonPreview("x".repeat(2500));
  assert.ok(long.startsWith("x".repeat(2000)));
  assert.ok(long.endsWith("… 500 more characters"));
});
