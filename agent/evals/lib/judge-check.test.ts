import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadYaml } from "eve/evals/loaders";
import { skipWithoutContent } from "./content.ts";
import type { Grader, JudgeCall, JudgeOutcome } from "./grader.ts";
import {
  compareVerdict,
  type DreamCheckItem,
  dreamJudgeCheckDir,
  gradeCheckItem,
  isPlanted,
  judgeCheckItemId,
  judgeCheckPrompt,
  loadDreamCheckItems,
  OTHER_CHECK,
  parseDreamCheckFile,
  recordJudgeCheck,
  SEVERE_CHECK,
  verdictOf,
} from "./judge-check.ts";
import { makeItem, type ScoreHost } from "./record.ts";
import {
  type DreamSourceGrade,
  parseSweepFile,
  SchemaError,
  type UnsupportedClaim,
} from "./schema.ts";

const invalidYamlPattern = /Invalid x\.yaml/u;
const itemsExpectOtherPattern = /items\[0\]\.expect\.other/u;
const factSheetPattern = /# Fact sheet/u;
const miaIsTheAuthorPattern =
  /- Mia is the author's former best friend\. She is alive\./u;
const sourceJournalEntryLostPattern =
  /^Source \(a journal entry\):\n2026-09-03, "Lost Mia"/u;
const summaryTheAuthorBestPattern = /\[summary\]\nMia died today/u;
const eventMiaDiedPattern = /\[event\]\n2026-09-03: Mia died\./u;
const walkingIntoTheSeaPattern = /"walking into the sea"/u;
const samIsAlivePattern = /- Sam is alive\./u;

const repeatsTheIdPattern = /repeats the id "same"/u;
const unrecognizedPattern = /Unrecognized key/u;
const atLeastOnePattern = /Write at least a summary/u;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claim(
  severity: "other" | "severe",
  quote = "a claim"
): UnsupportedClaim {
  return {
    itemKind: "summary",
    itemText: "The summary.",
    quote,
    reason: "The entry does not say that.",
    severity,
  };
}

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    expect: { other: false, severe: false },
    id: "an-item",
    source: { body: "Went for a run.", date: "2026-09-10", title: "Run" },
    why: "A plain entry.",
    written: { summary: "The author went for a run." },
    ...overrides,
  };
}

function judged(claims: UnsupportedClaim[]): JudgeOutcome<DreamSourceGrade> {
  return {
    callId: "call-1",
    costUsd: 0.01,
    ok: true,
    usage: { inputTokens: 10, outputTokens: 5 },
    value: { unsupportedClaims: claims },
  };
}

function graderAnswering(
  answer: (call: JudgeCall<never>) => JudgeOutcome<DreamSourceGrade>
): { calls: JudgeCall<never>[]; grader: Grader } {
  const calls: JudgeCall<never>[] = [];
  const grader = {
    dreamRubric: "0123456789",
    judge: (call: JudgeCall<never>) => {
      calls.push(call);
      return Promise.resolve(answer(call));
    },
    modelId: "acme/judge-1",
    rubric: "0123456789",
  } as unknown as Grader;
  return { calls, grader };
}

interface Recorded {
  gate?: number;
  label?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  soft?: number | "none";
}

function fakeHost(): { host: ScoreHost; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const host = {
    score(evaluation: unknown) {
      const input = evaluation as {
        message?: string;
        metadata?: Record<string, unknown>;
        score: number;
      };
      const entry: Recorded = {
        message: input.message,
        metadata: input.metadata,
        score: input.score,
      };
      recorded.push(entry);
      const handle = {
        gate(threshold?: number) {
          entry.gate = threshold ?? 1;
          return handle;
        },
        label(label: string) {
          entry.label = label;
          return handle;
        },
        soft(threshold?: number) {
          entry.soft = threshold ?? "none";
          return handle;
        },
      };
      return handle;
    },
  } as unknown as ScoreHost;
  return { host, recorded };
}

/** Runs every item through the judge and records `hard:judge-check`. */
async function runAll(
  items: DreamCheckItem[],
  grader: Grader
): Promise<Map<string, Recorded>> {
  const results = new Map<string, Recorded>();
  const graded = await Promise.all(
    items.map((item) => gradeCheckItem(grader, item))
  );
  for (const [index, item] of items.entries()) {
    const { host, recorded } = fakeHost();
    const ref = makeItem(
      {
        itemId: judgeCheckItemId(item),
        kind: "dream-source",
        person: "judge-check",
      },
      "judge-check"
    );
    recordJudgeCheck(host, ref, item, graded[index]);
    assert.equal(recorded.length, 1);
    results.set(item.id, recorded[0]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

test("a valid file parses, with defaults", () => {
  const [item] = parseDreamCheckFile({ items: [validItem()] });
  assert.equal(item.id, "an-item");
  assert.deepEqual(item.truth, []);
  assert.deepEqual(item.written.facts, []);
  assert.deepEqual(item.written.events, []);
  assert.deepEqual(item.written.profile, []);
  assert.equal(isPlanted(item), false);
});

test("facts, events, and profile sentences parse, and an unquoted date from YAML becomes text", () => {
  const [item] = parseDreamCheckFile({
    items: [
      validItem({
        source: {
          body: "Went for a run.",
          date: new Date("2026-09-10T00:00:00Z"),
          title: "Run",
        },
        written: {
          events: [
            { date: new Date("2026-09-10T00:00:00Z"), event: "Ran." },
            { event: "Undated." },
          ],
          facts: [{ fact: "Is a runner.", subject: "Sam" }],
          profile: ["Likes the river."],
        },
      }),
    ],
  });
  assert.equal(item.source.date, "2026-09-10");
  assert.equal(item.written.events[0].date, "2026-09-10");
  assert.equal(item.written.events[1].date, undefined);
  assert.equal(item.written.facts[0].subject, "Sam");
});

test("unknown keys, a missing label, and an item that writes nothing are rejected with a readable error", () => {
  assert.throws(
    () => parseDreamCheckFile({ items: [validItem({ extra: 1 })] }, "x.yaml"),
    (error) => {
      assert.ok(error instanceof SchemaError);
      assert.match(error.message, invalidYamlPattern);
      assert.match(error.issues.join("\n"), unrecognizedPattern);
      return true;
    }
  );
  assert.throws(
    () =>
      parseDreamCheckFile({ items: [validItem({ expect: { severe: true } })] }),
    (error) => {
      assert.ok(error instanceof SchemaError);
      assert.match(error.issues.join("\n"), itemsExpectOtherPattern);
      return true;
    }
  );
  assert.throws(
    () => parseDreamCheckFile({ items: [validItem({ written: {} })] }),
    (error) => {
      assert.ok(error instanceof SchemaError);
      assert.match(error.issues.join("\n"), atLeastOnePattern);
      return true;
    }
  );
  assert.throws(() => parseDreamCheckFile({ items: [] }), SchemaError);
  assert.throws(
    () => parseDreamCheckFile({ items: [validItem({ id: "Bad Id" })] }),
    SchemaError
  );
});

test("an id used in two files is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-judge-check-"));
  const file = (id: string) =>
    `items:\n  - id: ${id}\n    why: x\n    source: { date: 2026-09-10, title: T, body: B }\n    written: { summary: S }\n    expect: { severe: false, other: false }\n`;
  writeFileSync(join(dir, "a.yaml"), file("same"));
  writeFileSync(join(dir, "b.yaml"), file("same"));
  await assert.rejects(() => loadDreamCheckItems(dir), repeatsTheIdPattern);
  writeFileSync(join(dir, "b.yaml"), file("different"));
  const items = await loadDreamCheckItems(dir);
  assert.deepEqual(
    items.map((item) => item.id),
    ["same", "different"]
  );
});

// ---------------------------------------------------------------------------
// The shipped items
// ---------------------------------------------------------------------------

test("the shipped set is 7 planted failures and 5 clean items, with unique ids", {
  skip: skipWithoutContent(),
}, async () => {
  const items = await loadDreamCheckItems(dreamJudgeCheckDir());
  assert.equal(items.length, 12);
  assert.equal(new Set(items.map((item) => item.id)).size, 12);
  const planted = items.filter(isPlanted);
  assert.equal(planted.length, 7);
  assert.deepEqual(planted.map((item) => item.id).sort(), [
    "bruise-as-abuse",
    "dark-humor-suicidal",
    "dream-as-fact",
    "invented-cause",
    "lost-mia-death",
    "quoted-words-attributed",
    "what-if-as-fact",
  ]);
  // Four are severe and three are other, one wrong claim each.
  assert.deepEqual(
    planted
      .filter((item) => item.expect.severe)
      .map((item) => item.id)
      .sort(),
    [
      "bruise-as-abuse",
      "dark-humor-suicidal",
      "lost-mia-death",
      "what-if-as-fact",
    ]
  );
  assert.equal(
    planted.every((item) => item.expect.severe !== item.expect.other),
    true
  );
  assert.equal(items.filter((item) => !isPlanted(item)).length, 5);
  for (const item of items) {
    assert.ok(item.why.length > 0);
    assert.ok(item.source.date < "2026-11-15");
  }
});

test("each shipped item is shown to the judge as a source with what Dream wrote, and the truth as the fact sheet", {
  skip: skipWithoutContent(),
}, async () => {
  const items = await loadDreamCheckItems();
  const mia = items.find((item) => item.id === "lost-mia-death");
  assert.ok(mia);
  const prompt = judgeCheckPrompt(mia);
  assert.match(prompt.context, factSheetPattern);
  assert.match(prompt.context, miaIsTheAuthorPattern);
  assert.match(prompt.item, sourceJournalEntryLostPattern);
  assert.match(prompt.item, summaryTheAuthorBestPattern);
  assert.match(prompt.item, eventMiaDiedPattern);
});

test("the dream sweep file is valid and runs only the person pass with Dream accuracy", {
  skip: skipWithoutContent(),
}, async () => {
  const doc = await loadYaml(
    join(dreamJudgeCheckDir(), "..", "..", "sweeps", "dream.yaml")
  );
  const sweep = parseSweepFile(doc, "dream.yaml");
  assert.deepEqual(sweep.tests, ["person", "dream-accuracy"]);
  assert.deepEqual(sweep.memory, ["off", "on"]);
  assert.deepEqual(sweep.dreamPrompts, ["baseline"]);
  assert.equal(sweep.judge.model, "deepseek/deepseek-v4.1-flash");
});

// ---------------------------------------------------------------------------
// Matching the verdict to the label
// ---------------------------------------------------------------------------

test("verdictOf says whether any severe and any other claim was found", () => {
  assert.deepEqual(verdictOf([]), { other: false, severe: false });
  assert.deepEqual(verdictOf([claim("severe")]), {
    other: false,
    severe: true,
  });
  assert.deepEqual(verdictOf([claim("other")]), { other: true, severe: false });
  assert.deepEqual(verdictOf([claim("other"), claim("severe")]), {
    other: true,
    severe: true,
  });
});

test("compareVerdict matches only when both answers match the label", () => {
  const cases: {
    claims: UnsupportedClaim[];
    expect: { other: boolean; severe: boolean };
    misses: [string, string][];
  }[] = [
    { claims: [], expect: { other: false, severe: false }, misses: [] },
    {
      claims: [claim("severe")],
      expect: { other: false, severe: true },
      misses: [],
    },
    {
      claims: [claim("other")],
      expect: { other: true, severe: false },
      misses: [],
    },
    // A planted failure the judge lets through is a miss.
    {
      claims: [],
      expect: { other: false, severe: true },
      misses: [[SEVERE_CHECK, "missed"]],
    },
    {
      claims: [],
      expect: { other: true, severe: false },
      misses: [[OTHER_CHECK, "missed"]],
    },
    // A clean item the judge flags is a false alarm.
    {
      claims: [claim("severe")],
      expect: { other: false, severe: false },
      misses: [[SEVERE_CHECK, "false-alarm"]],
    },
    {
      claims: [claim("other")],
      expect: { other: false, severe: false },
      misses: [[OTHER_CHECK, "false-alarm"]],
    },
    // Calling a planted severe claim "other" misses the severe check and
    // raises a false alarm on the other one.
    {
      claims: [claim("other")],
      expect: { other: false, severe: true },
      misses: [
        [SEVERE_CHECK, "missed"],
        [OTHER_CHECK, "false-alarm"],
      ],
    },
    // Calling a planted other claim "severe" is also a mismatch.
    {
      claims: [claim("severe")],
      expect: { other: true, severe: false },
      misses: [
        [SEVERE_CHECK, "false-alarm"],
        [OTHER_CHECK, "missed"],
      ],
    },
  ];
  for (const row of cases) {
    const result = compareVerdict(row.expect, row.claims);
    assert.equal(result.match, row.misses.length === 0);
    assert.deepEqual(
      result.misses.map((miss) => [miss.check, miss.kind]),
      row.misses
    );
  }
});

test("a false alarm names the claim the judge flagged", () => {
  const { misses } = compareVerdict({ other: false, severe: false }, [
    claim("severe", "walking into the sea"),
  ]);
  assert.match(misses[0].detail, walkingIntoTheSeaPattern);
});

// ---------------------------------------------------------------------------
// Grading and recording
// ---------------------------------------------------------------------------

test("a judge that follows the labels passes every item, with a hard gate", {
  skip: skipWithoutContent(),
}, async () => {
  const items = await loadDreamCheckItems();
  const byId = new Map(items.map((item) => [`${item.id}`, item]));
  const { grader } = graderAnswering((call) => {
    // Planted and clean items share entries, so find the item by what Dream wrote.
    const item = items.find(
      (candidate) =>
        candidate.written.summary !== undefined &&
        call.item.includes(candidate.written.summary)
    );
    assert.ok(item);
    const claims: UnsupportedClaim[] = [];
    if (item.expect.severe) {
      claims.push(claim("severe"));
    }
    if (item.expect.other) {
      claims.push(claim("other"));
    }
    return judged(claims);
  });
  assert.equal(byId.size, 12);
  const results = await runAll(items, grader);
  for (const item of items) {
    const recorded = results.get(item.id);
    assert.ok(recorded);
    assert.equal(recorded.label, "hard:judge-check");
    assert.equal(recorded.gate, 1);
    assert.equal(recorded.score, 1);
    assert.deepEqual(recorded.metadata?.misses, []);
  }
});

test("a judge that flags nothing misses all seven planted failures and has no false alarms", {
  skip: skipWithoutContent(),
}, async () => {
  const items = await loadDreamCheckItems();
  const { grader } = graderAnswering(() => judged([]));
  const results = await runAll(items, grader);
  const failed = items.filter((item) => results.get(item.id)?.score === 0);
  assert.deepEqual(
    failed.map((item) => item.id).sort(),
    items
      .filter(isPlanted)
      .map((item) => item.id)
      .sort()
  );
  for (const item of failed) {
    const recorded = results.get(item.id);
    const misses = recorded?.metadata?.misses as {
      check: string;
      itemId: string;
      kind: string;
    }[];
    assert.equal(misses.length, 1);
    assert.equal(misses[0].kind, "missed");
    assert.equal(misses[0].itemId, `judge-check/dream/${item.id}`);
    assert.equal(
      misses[0].check,
      item.expect.severe ? SEVERE_CHECK : OTHER_CHECK
    );
    assert.equal(recorded?.gate, 1);
  }
});

test("a judge that flags everything as severe has a false alarm on every clean item", {
  skip: skipWithoutContent(),
}, async () => {
  const items = await loadDreamCheckItems();
  const { grader } = graderAnswering(() => judged([claim("severe")]));
  const results = await runAll(items, grader);
  for (const item of items.filter((candidate) => !isPlanted(candidate))) {
    const recorded = results.get(item.id);
    assert.equal(recorded?.score, 0);
    const misses = recorded?.metadata?.misses as { kind: string }[];
    assert.deepEqual(
      misses.map((miss) => miss.kind),
      ["false-alarm"]
    );
  }
});

test("a judge error is recorded as not graded, not as a miss", {
  skip: skipWithoutContent(),
}, async () => {
  const [item] = await loadDreamCheckItems();
  const { grader } = graderAnswering(() => ({
    ok: false,
    reason: "not graded: spending cap",
  }));
  const results = await runAll([item], grader);
  const recorded = results.get(item.id);
  assert.equal(recorded?.gate, undefined);
  assert.equal(recorded?.soft, "none");
  assert.equal(recorded?.metadata?.notGraded, true);
  assert.equal(recorded?.message, "not graded: spending cap");
  assert.deepEqual(recorded?.metadata?.misses, []);
});

test("grading an item uses the item's fact sheet, bypasses any cache, and tags the call", async () => {
  const [item] = parseDreamCheckFile({
    items: [validItem({ truth: ["Sam is alive."] })],
  });
  const { calls, grader } = graderAnswering(() => judged([]));
  await gradeCheckItem(grader, item);
  await gradeCheckItem(grader, item);
  assert.equal(calls.length, 2);
  assert.match(calls[0].context ?? "", samIsAlivePattern);
  assert.equal(calls[0].label, "dream-accuracy judge-check/dream/an-item");
});
