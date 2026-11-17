import assert from "node:assert/strict";
import test from "node:test";

import {
  compareLabels,
  differingDimensions,
  failsOnEitherSide,
  filterCompared,
  filterOptions,
  filterParams,
  missingCounts,
  pairItems,
  parseCompareQuery,
  summaryRows,
} from "./compare.ts";
import { parseSetupReport } from "./sweep-parse.ts";
import { sampleFiles, sampleSetupIds, sampleSweepId } from "./sweep-samples.ts";
import type { SetupReport } from "./sweep-types.ts";

function report(setupId: string): SetupReport {
  const text = sampleFiles()[`${sampleSweepId}__${setupId}.report.json`] ?? "";
  const outcome = parseSetupReport(text);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value;
}

const best = () => report(sampleSetupIds.best);
const steady = () => report(sampleSetupIds.steady);

test("parseCompareQuery reads the setups and the filters", () => {
  assert.deepEqual(
    parseCompareQuery({
      a: "3f9a1c7b2e",
      b: ["8d20e4a6b1", "ignored"],
      expect: "venting",
      failing: "1",
      kind: "opener",
      person: "engaged",
    }),
    {
      a: "3f9a1c7b2e",
      b: "8d20e4a6b1",
      expect: "venting",
      failing: true,
      kind: "opener",
      person: "engaged",
    }
  );
  assert.deepEqual(parseCompareQuery({ failing: "on", person: "" }), {
    a: undefined,
    b: undefined,
    expect: undefined,
    failing: true,
    kind: undefined,
    person: undefined,
  });
  assert.equal(parseCompareQuery({ failing: "no" }).failing, false);
  assert.equal(parseCompareQuery({}).failing, false);
});

test("filterParams keeps only the filters that are set", () => {
  assert.deepEqual(
    filterParams(parseCompareQuery({ a: "x", failing: "1", person: "grief" })),
    { failing: "1", person: "grief" }
  );
  assert.deepEqual(filterParams(parseCompareQuery({})), {});
});

test("pairItems joins the items of two setups by id and repeat", () => {
  const pairs = pairItems(best(), steady());
  const byId = new Map(pairs.map((pair) => [pair.itemId, pair]));
  const both = byId.get("engaged/opener/rent-panic");
  assert.ok(both?.a && both.b);
  assert.notEqual(both.a.turns[1]?.text, both.b.turns[1]?.text);
  assert.equal(both.expect, "venting");
  // Only the steady setup ran this one, and only the best setup has the chat dream source.
  assert.equal(byId.get("engaged/opener/jordan-update")?.a, undefined);
  assert.ok(byId.get("engaged/opener/jordan-update")?.b);
  assert.equal(byId.get("grief/dream/chat-2")?.a !== undefined, true);
  assert.deepEqual(missingCounts(pairs), { a: 1, b: 0 });
});

test("pairItems orders by person, then item id, then repeat", () => {
  const first = best();
  const second = steady();
  const [, repeat] = first.items;
  assert.ok(repeat);
  first.items.push({ ...repeat, repeat: 2 });
  const pairs = pairItems(first, second);
  assert.deepEqual(
    pairs.map((pair) => pair.person),
    [...pairs.map((pair) => pair.person)].sort((x, y) => x.localeCompare(y))
  );
  const rentKeys = pairs
    .filter((pair) => pair.itemId === "engaged/opener/rent-panic")
    .map((pair) => pair.repeat);
  assert.deepEqual(rentKeys, [1, 2]);
  const extra = pairs.find(
    (pair) => pair.itemId === "engaged/opener/rent-panic" && pair.repeat === 2
  );
  assert.ok(extra?.a);
  assert.equal(extra.b, undefined);
});

test("failsOnEitherSide looks at both setups", () => {
  const pairs = pairItems(best(), steady());
  const rent = pairs.find((pair) => pair.itemId.endsWith("rent-panic"));
  const retrieval = pairs.find((pair) => pair.itemId.endsWith("retrieval/1"));
  assert.ok(rent && retrieval);
  assert.equal(failsOnEitherSide(rent), true);
  assert.equal(failsOnEitherSide(retrieval), false);
});

test("filterCompared filters by person, kind, expect, and failing", () => {
  const pairs = pairItems(best(), steady());
  const ids = (query: Record<string, string>) =>
    filterCompared(pairs, parseCompareQuery(query)).map((pair) => pair.itemId);

  assert.equal(ids({}).length, pairs.length);
  assert.ok(ids({ person: "grief" }).every((id) => id.startsWith("grief/")));
  assert.deepEqual(ids({ kind: "retrieval" }), ["engaged/retrieval/1"]);
  assert.deepEqual(ids({ expect: "question" }), [
    "engaged/opener/jordan-update",
  ]);
  assert.deepEqual(ids({ expect: "venting", kind: "opener" }), [
    "engaged/opener/rent-panic",
    "grief/opener/lost-mia",
  ]);
  const failing = ids({ failing: "1" });
  assert.ok(failing.includes("engaged/opener/rent-panic"));
  assert.ok(failing.includes("grief/dream/entry-3"));
  assert.ok(!failing.includes("engaged/retrieval/1"));
  assert.deepEqual(ids({ failing: "1", person: "nobody" }), []);
});

test("filterOptions lists each value once, in order", () => {
  const options = filterOptions(pairItems(best(), steady()));
  assert.deepEqual(options.people, ["engaged", "grief"]);
  assert.deepEqual(options.kinds, [
    "conversation",
    "dream-source",
    "opener",
    "retrieval",
  ]);
  assert.deepEqual(options.expects, ["question", "venting"]);
});

test("summaryRows sets the two setups' numbers side by side", () => {
  const rows = summaryRows(best(), report(sampleSetupIds.slow));
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  assert.deepEqual(byLabel.get("Hard checks"), {
    a: "Passed",
    b: "Failed: Fast enough",
    label: "Hard checks",
  });
  assert.deepEqual(byLabel.get("Counted failures"), {
    a: "1 · 4.0%",
    b: "0 · 2.0%",
    label: "Counted failures",
  });
  assert.equal(byLabel.get("Rubric mean")?.a, "0.78");
  assert.equal(byLabel.get("Rubric spread")?.b, "—");
  assert.equal(byLabel.get("First word, p90")?.b, "41.0s");
  assert.equal(byLabel.get("Cost")?.a, "$1.20");
  assert.equal(byLabel.get("Graded · not graded")?.b, "25 · 2");
  assert.equal(rows.length, 9);
});

test("differingDimensions and compareLabels name what sets two setups apart", () => {
  const a = best();
  const b = steady();
  assert.deepEqual(differingDimensions(a.setup, b.setup), [
    "chatModel",
    "prompt",
  ]);
  assert.deepEqual(compareLabels(a, b), {
    a: "qwen3:14b · companion-v1",
    b: "qwen3.5:9b · baseline",
  });
  const same = compareLabels(a, a);
  assert.equal(same.a, same.b);
  assert.equal(same.a, "qwen3:14b · companion-v1");
});
