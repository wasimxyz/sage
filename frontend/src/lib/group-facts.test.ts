import assert from "node:assert/strict";
import test from "node:test";

import type { FactMemory } from "../bridge.ts";
import {
  displaySubject,
  factSubjectKey,
  groupFactsBySubject,
  groupForSubjectKey,
} from "./group-facts.ts";

function fact(input: {
  fact: string;
  id: number;
  subject: string;
  updatedAt: string;
}): FactMemory {
  return {
    fact: input.fact,
    id: input.id,
    pinned: true,
    sourceId: 0,
    sourceType: "user",
    subject: input.subject,
    updatedAt: input.updatedAt,
  };
}

test("groupFactsBySubject keeps the same subject in one group", () => {
  const groups = groupFactsBySubject([
    fact({
      fact: "Lives across town",
      id: 2,
      subject: "Maya",
      updatedAt: "2026-09-19T12:00:00.000Z",
    }),
    fact({
      fact: "Brought soup",
      id: 3,
      subject: "Sam",
      updatedAt: "2026-09-18T12:00:00.000Z",
    }),
    fact({
      fact: "Lives nearby",
      id: 1,
      subject: "maya",
      updatedAt: "2026-09-17T12:00:00.000Z",
    }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.subject, "Maya");
  assert.equal(groups[0]?.snippet, "Lives across town");
  assert.equal(groups[0]?.facts.length, 2);
  assert.equal(groups[0]?.facts[1]?.fact, "Lives nearby");
  assert.equal(groups[1]?.subject, "Sam");
});

test("groupFactsBySubject sorts groups by the newest fact", () => {
  const groups = groupFactsBySubject([
    fact({
      fact: "Lives nearby",
      id: 1,
      subject: "Maya",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }),
    fact({
      fact: "Took a train",
      id: 2,
      subject: "Travel",
      updatedAt: "2026-09-02T00:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.subject),
    ["Travel", "Maya"]
  );
});

test("factSubjectKey trims and lowercases", () => {
  assert.equal(factSubjectKey("  Maya "), "maya");
  assert.equal(displaySubject("  "), "Fact");
});

test("groupForSubjectKey finds a group after casing differences", () => {
  const facts = [
    fact({
      fact: "Lives nearby",
      id: 1,
      subject: "Maya",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }),
  ];
  const group = groupForSubjectKey(facts, factSubjectKey("MAYA"));
  assert.equal(group?.facts.length, 1);
  assert.equal(groupForSubjectKey(facts, "sam"), null);
});
