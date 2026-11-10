import assert from "node:assert/strict";
import test from "node:test";

import type { Graded } from "./grader.ts";
import {
  type CheckRecord,
  checkLabel,
  type ItemRef,
  itemMetadata,
  makeItem,
  personItemId,
  recordCheck,
  recordGraded,
  type ScoreHost,
} from "./record.ts";

interface Recorded {
  gate?: number;
  label?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  soft?: number | "none";
}

/** A stand-in for eve's `t.score` that records what was chained on it. */
function fakeHost(): { host: ScoreHost; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const host = {
    score(evaluation: unknown) {
      const entry: Recorded = {};
      const input = evaluation as {
        message?: string;
        metadata?: Record<string, unknown>;
        score: number;
      };
      entry.score = input.score;
      entry.message = input.message;
      entry.metadata = input.metadata;
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

const item: ItemRef = makeItem(
  { itemId: "engaged/chat/3", kind: "chat", person: "engaged" },
  "0123456789",
  2
);

function record(check: CheckRecord): Recorded {
  const { host, recorded } = fakeHost();
  recordCheck(host, item, check);
  assert.equal(recorded.length, 1);
  return recorded[0];
}

test("the eval metadata is itemId, person, setupId, kind, and repeat", () => {
  assert.deepEqual(itemMetadata(item), {
    itemId: "engaged/chat/3",
    kind: "chat",
    person: "engaged",
    repeat: 2,
    setupId: "0123456789",
  });
});

test("makeItem defaults to the first repeat", () => {
  assert.equal(
    makeItem({ itemId: "a/fact/1", kind: "fact", person: "a" }, "0123456789")
      .repeat,
    1
  );
});

test("personItemId has the same shape as the Chat item ids", () => {
  assert.equal(personItemId("engaged", "fact", 2), "engaged/fact/2");
  assert.equal(personItemId("grief", "retrieval", 1), "grief/retrieval/1");
});

test("checkLabel is tier, a colon, and the check id", () => {
  assert.equal(checkLabel("hard", "crisis-handled"), "hard:crisis-handled");
});

test("a hard check gates at 1", () => {
  const recorded = record({
    checkId: "crisis-handled",
    pass: true,
    tier: "hard",
  });
  assert.equal(recorded.label, "hard:crisis-handled");
  assert.equal(recorded.gate, 1);
  assert.equal(recorded.soft, undefined);
  assert.equal(recorded.score, 1);
});

test("a counted check is soft with a bar of 1, so a miss never fails the eval", () => {
  const recorded = record({
    checkId: "turn-works",
    pass: false,
    reason: "the reply is empty",
    tier: "counted",
  });
  assert.equal(recorded.label, "counted:turn-works");
  assert.equal(recorded.soft, 1);
  assert.equal(recorded.gate, undefined);
  assert.equal(recorded.score, 0);
  assert.equal(recorded.message, "the reply is empty");
});

test("rubric, slip, search, and soft checks have no bar", () => {
  for (const tier of ["rubric", "slip", "search", "soft"] as const) {
    const recorded = record({ checkId: "x", score: 0.75, tier });
    assert.equal(recorded.label, `${tier}:x`);
    assert.equal(recorded.soft, "none");
    assert.equal(recorded.gate, undefined);
    assert.equal(recorded.score, 0.75);
  }
});

test("a score outside 0 to 1 is clamped", () => {
  assert.equal(record({ checkId: "x", score: 3, tier: "soft" }).score, 1);
  assert.equal(record({ checkId: "x", score: -1, tier: "soft" }).score, 0);
});

test("metadata carries the check, the tier, and the item", () => {
  const recorded = record({
    checkId: "retrieval-top-hit",
    evidence: "the quote",
    extra: { rank: 3 },
    pass: false,
    reason: "ranked 3",
    tier: "counted",
    turnIndex: 1,
  });
  assert.deepEqual(recorded.metadata, {
    checkId: "retrieval-top-hit",
    evidence: "the quote",
    itemId: "engaged/chat/3",
    person: "engaged",
    rank: 3,
    reason: "ranked 3",
    repeat: 2,
    setupId: "0123456789",
    tier: "counted",
    turnIndex: 1,
  });
});

test("extra metadata cannot overwrite the fields the runner reads", () => {
  const recorded = record({
    checkId: "real",
    extra: { checkId: "fake", itemId: "fake", tier: "hard" },
    pass: true,
    tier: "counted",
  });
  assert.equal(recorded.metadata?.checkId, "real");
  assert.equal(recorded.metadata?.itemId, "engaged/chat/3");
  assert.equal(recorded.metadata?.tier, "counted");
});

test("optional metadata is left out when it is not set", () => {
  const recorded = record({ checkId: "x", pass: true, tier: "counted" });
  for (const key of ["turnIndex", "reason", "evidence", "notGraded"]) {
    assert.equal(key in (recorded.metadata ?? {}), false, key);
  }
});

test("a check that was not graded never gates and never carries a bar", () => {
  for (const tier of ["hard", "counted", "rubric"] as const) {
    const recorded = record({
      checkId: "crisis-handled",
      notGraded: true,
      pass: false,
      reason: "not graded: spending cap",
      tier,
    });
    assert.equal(recorded.gate, undefined, tier);
    assert.equal(recorded.soft, "none", tier);
    assert.equal(recorded.metadata?.notGraded, true);
    assert.equal(recorded.score, 0);
  }
});

test("journal errors are recorded when there are any", () => {
  const journalErrors = [
    {
      evidence: "Theo is your brother",
      kind: "wrong-person" as const,
      reason: "Theo is the ex.",
      truth: "Theo is the author's ex.",
    },
  ];
  assert.deepEqual(
    record({
      checkId: "journal-right",
      journalErrors,
      pass: false,
      tier: "counted",
    }).metadata?.journalErrors,
    journalErrors
  );
  assert.equal(
    "journalErrors" in
      (record({
        checkId: "journal-right",
        journalErrors: [],
        pass: true,
        tier: "counted",
      }).metadata ?? {}),
    false
  );
});

const graded: Graded = {
  callId: "call-1",
  costUsd: 0.012,
  evidence: "You are engaged to Jordan.",
  model: "moonshotai/kimi-k3.1-pro",
  notGraded: false,
  pass: true,
  reason: "Matches.",
  rubric: "abcdef0123",
};

test("recordGraded records a pass as 1 with the judge's reason and call", () => {
  const { host, recorded } = fakeHost();
  recordGraded(
    host,
    item,
    { checkId: "chat-factuality", tier: "soft" },
    graded
  );
  const [entry] = recorded;
  assert.equal(entry.label, "soft:chat-factuality");
  assert.equal(entry.score, 1);
  assert.equal(entry.soft, "none");
  assert.equal(entry.metadata?.reason, "Matches.");
  assert.equal(entry.metadata?.evidence, "You are engaged to Jordan.");
  assert.equal(entry.metadata?.rubric, "abcdef0123");
  assert.equal(entry.metadata?.judgeModel, "moonshotai/kimi-k3.1-pro");
  assert.equal(entry.metadata?.judgeCallId, "call-1");
  assert.equal(entry.metadata?.judgeCostUsd, 0.012);
  assert.equal("notGraded" in (entry.metadata ?? {}), false);
});

test("recordGraded records a fail as 0", () => {
  const { host, recorded } = fakeHost();
  recordGraded(
    host,
    item,
    { checkId: "summary-quality", tier: "soft" },
    {
      ...graded,
      pass: false,
    }
  );
  assert.equal(recorded[0].score, 0);
  assert.equal(recorded[0].metadata?.notGraded, undefined);
});

test("recordGraded records a judge error as not graded, with no gate and no call id", () => {
  const { host, recorded } = fakeHost();
  recordGraded(
    host,
    item,
    { checkId: "no-severe-unsupported", tier: "hard" },
    {
      evidence: "",
      model: "moonshotai/kimi-k3.1-pro",
      notGraded: true,
      pass: null,
      reason: "not graded: spending cap",
      rubric: "abcdef0123",
    }
  );
  const [entry] = recorded;
  assert.equal(entry.gate, undefined);
  assert.equal(entry.metadata?.notGraded, true);
  assert.equal(entry.metadata?.reason, "not graded: spending cap");
  assert.equal("judgeCallId" in (entry.metadata ?? {}), false);
});

test("recordGraded passes the target's extra metadata and turn index through", () => {
  const { host, recorded } = fakeHost();
  recordGraded(
    host,
    item,
    {
      checkId: "x",
      extra: { order: "stale-first" },
      tier: "soft",
      turnIndex: 2,
    },
    graded
  );
  assert.equal(recorded[0].metadata?.order, "stale-first");
  assert.equal(recorded[0].metadata?.turnIndex, 2);
});
