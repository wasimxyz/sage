import assert from "node:assert/strict";
import test from "node:test";

import { EVAL_TODAY } from "./eve.ts";
import {
  countItems,
  dataProblems,
  itemMatchesTags,
  loadAllPeople,
  personInSweep,
  selectPeople,
} from "./people.ts";
import { conversation, makePerson, opener } from "./test-fixtures.ts";

const pattern1 = /^sam: /u;

test("with no sweep tags every person and item is in", () => {
  const sam = makePerson("sam", { openers: [opener("a")] });
  assert.equal(personInSweep(sam, []), true);
  assert.equal(itemMatchesTags(sam, [], []), true);
  assert.deepEqual(
    selectPeople([sam], []).map((p) => p.id),
    ["sam"]
  );
});

test("a person is in when their tags or any opener's or conversation's tags match", () => {
  const byPerson = makePerson("a", { tags: ["example"] });
  const byOpener = makePerson("b", { openers: [opener("o", ["screen"])] });
  const byConversation = makePerson("c", {
    conversations: [conversation("c1", 6, ["screen"])],
  });
  const none = makePerson("d", {
    openers: [opener("o", ["quick"])],
    tags: ["work"],
  });
  const people = [byPerson, byOpener, byConversation, none];
  assert.deepEqual(
    selectPeople(people, ["example"]).map((p) => p.id),
    ["a"]
  );
  assert.deepEqual(
    selectPeople(people, ["screen"]).map((p) => p.id),
    ["b", "c"]
  );
  assert.deepEqual(
    selectPeople(people, ["screen", "work"]).map((p) => p.id),
    ["b", "c", "d"]
  );
});

test("an item matches by its own tags or its person's", () => {
  const sam = makePerson("sam", { tags: ["example"] });
  assert.equal(itemMatchesTags(sam, [], ["example"]), true);
  assert.equal(itemMatchesTags(sam, ["quick"], ["quick"]), true);
  assert.equal(itemMatchesTags(sam, ["slow"], ["quick"]), false);
});

test("countItems counts what a person holds", () => {
  const sam = makePerson("sam", {
    chat: [
      { question: "q1", reference: "r1" },
      { question: "q2", reference: "r2" },
    ],
    entries: 5,
    events: [{ entry: 1, reference: "e" }],
    facts: [{ reference: "f", subject: "s" }],
    retrieval: [{ expectEntry: 2, query: "q" }],
    summaries: [{ entry: 3, reference: "s" }],
  });
  assert.deepEqual(countItems(sam, []), {
    chatRefs: 2,
    conversations: 0,
    conversationTurns: 0,
    entries: 5,
    judgedRefs: 3,
    openers: 0,
    personChecks: 4,
    summaryRefs: 1,
  });
});

test("the real people load and pass the data checks as of the pinned day", async () => {
  const people = await loadAllPeople();
  assert.ok(people.length >= 1);
  assert.ok(people.some((person) => person.id === "sam-example"));
  assert.deepEqual(dataProblems(people, EVAL_TODAY), []);
  const sam = people.find((person) => person.id === "sam-example");
  assert.deepEqual(sam?.personCase.tags, ["example"]);
  assert.deepEqual(
    selectPeople(people, ["example"]).map((p) => p.id),
    ["sam-example"]
  );
});

test("dataProblems names the person", () => {
  const sam = makePerson("sam", {
    events: [{ entry: "no-such-stem", reference: "x" }],
  });
  const problems = dataProblems([sam], EVAL_TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", pattern1);
});
