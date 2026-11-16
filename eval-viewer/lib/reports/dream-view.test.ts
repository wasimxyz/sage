import assert from "node:assert/strict";
import test from "node:test";

import {
  dreamGroups,
  dreamKindLabel,
  filterDreamGroups,
  highlightClaims,
  writtenWithClaims,
} from "./dream-view.ts";
import { parseSetupReport } from "./sweep-parse.ts";
import { sampleSetupReport } from "./sweep-samples.ts";
import type { DreamSource, SetupReport } from "./sweep-types.ts";

function report(): SetupReport {
  const outcome = parseSetupReport(JSON.stringify(sampleSetupReport()));
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value;
}

function source(overrides: Partial<DreamSource> = {}): DreamSource {
  return {
    sourceId: "entry-1",
    sourceKind: "entry",
    sourceText: "",
    unsupportedClaims: [],
    written: [],
    ...overrides,
  };
}

test("dreamGroups groups Dream sources by person and counts the claims", () => {
  const groups = dreamGroups(report());
  assert.deepEqual(
    groups.map((group) => [
      group.person,
      group.sources.length,
      group.severe,
      group.other,
      group.withClaims,
      group.graded,
    ]),
    [
      ["grief", 2, 1, 1, 2, 2],
      ["engaged", 1, 0, 0, 0, 1],
    ]
  );
  assert.deepEqual(
    groups[0]?.sources.map((row) => row.source.sourceId),
    ["entry-3", "chat-2"]
  );
});

test("dreamGroups leaves out items with no Dream record and flags a source that was not graded", () => {
  const input = report();
  const dream = input.items.find((item) => item.dream !== undefined);
  assert.ok(dream);
  dream.status = "not-graded";
  const groups = dreamGroups(input);
  const grief = groups.find((group) => group.person === "grief");
  assert.equal(grief?.sources[0]?.notGraded, true);
  assert.equal(grief?.graded, 1);
  assert.equal(
    groups.some((group) =>
      group.sources.some((row) => row.item.kind !== "dream-source")
    ),
    false
  );
});

test("filterDreamGroups narrows to a person and to sources with claims", () => {
  const groups = dreamGroups(report());
  assert.deepEqual(
    filterDreamGroups(groups, "engaged", false).map((group) => group.person),
    ["engaged"]
  );
  assert.deepEqual(
    filterDreamGroups(groups, undefined, true).map((group) =>
      group.sources.map((row) => row.source.sourceId)
    ),
    [["entry-3", "chat-2"], []]
  );
  assert.deepEqual(filterDreamGroups(groups, "nobody", false), []);
});

test("writtenWithClaims matches a claim to the item whose text it names", () => {
  const view = writtenWithClaims(
    source({
      unsupportedClaims: [
        {
          itemKind: "fact",
          itemText: "Mia  and the\nauthor argued.",
          quote: "argued",
          reason: "r1",
          severity: "other",
        },
      ],
      written: [
        { itemKind: "summary", text: "A summary." },
        { itemKind: "fact", text: "Mia and the author argued." },
      ],
    })
  );
  assert.equal(view.items[0]?.claims.length, 0);
  assert.deepEqual(
    view.items[1]?.claims.map((entry) => entry.number),
    [1]
  );
  assert.deepEqual(view.strays, []);
});

test("writtenWithClaims falls back to the item that holds the quote, then to a stray", () => {
  const view = writtenWithClaims(
    source({
      unsupportedClaims: [
        {
          itemKind: "summary",
          itemText: "Text Dream never wrote.",
          quote: "the death of",
          reason: "r1",
          severity: "severe",
        },
        {
          itemKind: "summary",
          itemText: "Another text Dream never wrote.",
          quote: "nowhere to be found",
          reason: "r2",
          severity: "other",
        },
        {
          itemKind: "summary",
          itemText: "",
          quote: "",
          reason: "r3",
          severity: "other",
        },
      ],
      written: [{ itemKind: "summary", text: "They mourn the death of Mia." }],
    })
  );
  assert.deepEqual(
    view.items[0]?.claims.map((entry) => entry.number),
    [1]
  );
  assert.deepEqual(
    view.strays.map((entry) => entry.number),
    [2, 3]
  );
});

test("highlightClaims cuts the text at each quote", () => {
  const { segments, unplaced } = highlightClaims(
    "They mourn the death of Mia and cannot write about it.",
    [{ number: 1, quote: "the death of Mia" }]
  );
  assert.deepEqual(segments, [
    { start: 0, text: "They mourn " },
    { claim: 1, start: 11, text: "the death of Mia" },
    { start: 27, text: " and cannot write about it." },
  ]);
  assert.deepEqual(unplaced, []);
});

test("highlightClaims finds a quote that differs only in case", () => {
  const { segments } = highlightClaims("A dog named Biscuit.", [
    { number: 1, quote: "A DOG" },
  ]);
  assert.deepEqual(segments, [
    { claim: 1, start: 0, text: "A dog" },
    { start: 5, text: " named Biscuit." },
  ]);
});

test("highlightClaims orders several quotes and lists the ones it cannot place", () => {
  const { segments, unplaced } = highlightClaims("one two three four", [
    { number: 3, quote: "four" },
    { number: 1, quote: "one" },
    { number: 2, quote: "missing" },
    { number: 4, quote: "" },
    { number: 5, quote: "one two" },
  ]);
  // Quote 5 and quote 1 start at the same place, so the longer one is marked.
  assert.deepEqual(segments, [
    { claim: 5, start: 0, text: "one two" },
    { start: 7, text: " three " },
    { claim: 3, start: 14, text: "four" },
  ]);
  assert.deepEqual(unplaced, [1, 2, 4]);
});

test("highlightClaims keeps the whole text when there is nothing to mark", () => {
  assert.deepEqual(highlightClaims("Plain.", []), {
    segments: [{ start: 0, text: "Plain." }],
    unplaced: [],
  });
  assert.deepEqual(highlightClaims("", []), { segments: [], unplaced: [] });
});

test("dreamKindLabel names the kinds and passes others through", () => {
  assert.equal(dreamKindLabel("chat-summary"), "Chat summary");
  assert.equal(dreamKindLabel("profile"), "Profile");
  assert.equal(dreamKindLabel("something-new"), "something-new");
  assert.equal(dreamKindLabel("constructor"), "constructor");
});
