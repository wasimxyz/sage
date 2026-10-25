import assert from "node:assert/strict";
import test from "node:test";

import { readReply, shapeRangeResult } from "../agent/lib/search-result.ts";

const range = { from: "2026-03-01", label: "in March", to: "2026-03-31" };
const today = "2026-10-25";

function entry(id: number) {
  return {
    date: "2026-03-14",
    id,
    snippet: "A summary.",
    title: `Entry ${id}`,
  };
}

function search(payload: unknown, hasQuery: boolean) {
  return shapeRangeResult({ hasQuery, payload, range, today });
}

test("readReply treats missing or odd fields as empty", () => {
  assert.deepEqual(readReply(null), {
    belowCutoff: 0,
    entries: [],
    matched: 0,
    nearest: null,
    total: 0,
    unsummarized: 0,
  });
  assert.deepEqual(
    readReply({ entries: "nope", nearest: { before: 3 }, total: "9" }),
    {
      belowCutoff: 0,
      entries: [],
      matched: 0,
      nearest: { after: null, before: null },
      total: 0,
      unsummarized: 0,
    }
  );
});

test("a result always names the dates it used and today", () => {
  const result = search({ entries: [entry(1)], matched: 1, total: 1 }, true);
  assert.deepEqual(result.range, range);
  assert.equal(result.today, today);
  assert.deepEqual(result.entries, [entry(1)]);
  assert.equal("note" in result, false);
  assert.equal("nearest" in result, false);
});

test("an empty range names the nearest entries", () => {
  const empty = {
    entries: [],
    nearest: { after: "2026-04-02", before: "2026-02-27" },
    total: 0,
  };
  for (const hasQuery of [true, false]) {
    const result = search(empty, hasQuery);
    assert.equal(
      result.note,
      "No entries are dated from 2026-03-01 to 2026-03-31. The nearest entries are 2026-02-27 and 2026-04-02."
    );
    assert.deepEqual(result.nearest, empty.nearest);
  }
});

test("an empty range with one neighbor says entry, not entries", () => {
  const result = search(
    {
      entries: [],
      nearest: { after: null, before: "2026-02-27" },
      total: 0,
    },
    false
  );
  assert.equal(
    result.note,
    "No entries are dated from 2026-03-01 to 2026-03-31. The nearest entry is 2026-02-27."
  );
});

test("an empty range with no neighbors says only that nothing is dated there", () => {
  const result = shapeRangeResult({
    hasQuery: false,
    payload: { entries: [], nearest: { after: null, before: null }, total: 0 },
    range: { from: "2026-03-05", label: "2026-03-05", to: "2026-03-05" },
    today,
  });
  assert.equal(result.note, "No entries are dated on 2026-03-05.");
});

test("a search says how many entries in the range did not match", () => {
  const withMatch = search(
    { belowCutoff: 5, entries: [entry(1)], matched: 1, total: 6 },
    true
  );
  assert.equal(
    withMatch.note,
    "5 more entries from this range didn't match. Leave out query to see them."
  );

  const noMatch = search(
    { belowCutoff: 1, entries: [], matched: 0, total: 1 },
    true
  );
  assert.equal(
    noMatch.note,
    "1 entry in this range didn't match. Leave out query to see them."
  );
});

test("a search says when it shows only some of the matches", () => {
  const result = search(
    {
      belowCutoff: 0,
      entries: [entry(1), entry(2)],
      matched: 7,
      total: 7,
    },
    true
  );
  assert.equal(
    result.note,
    "Showing 2 of 7 matches. Narrow when to see the rest."
  );
});

test("a search counts entries that have no summary yet", () => {
  const many = search(
    { entries: [entry(1)], matched: 1, total: 4, unsummarized: 2 },
    true
  );
  assert.equal(
    many.note,
    "2 entries in this range have no summary yet, so search by meaning can't see them. Dream in the sidebar adds them."
  );

  const one = search(
    { entries: [entry(1)], matched: 1, total: 2, unsummarized: 1 },
    true
  );
  assert.equal(
    one.note,
    "1 entry in this range has no summary yet, so search by meaning can't see it. Dream in the sidebar adds it."
  );
});

test("search notes join in order", () => {
  const result = search(
    {
      belowCutoff: 3,
      entries: [entry(1)],
      matched: 4,
      total: 9,
      unsummarized: 2,
    },
    true
  );
  assert.equal(
    result.note,
    "3 more entries from this range didn't match. Leave out query to see them. Showing 1 of 4 matches. Narrow when to see the rest. 2 entries in this range have no summary yet, so search by meaning can't see them. Dream in the sidebar adds them."
  );
});

test("a date-only listing says when it shows a sample", () => {
  const sample = Array.from({ length: 10 }, (_, index) => entry(index + 1));
  const result = search({ entries: sample, total: 23 }, false);
  assert.equal(
    result.note,
    "Showing 10 of 23 entries from across the range. Add a query or narrow when to see more."
  );

  const all = search({ entries: [entry(1), entry(2)], total: 2 }, false);
  assert.equal("note" in all, false);
});
