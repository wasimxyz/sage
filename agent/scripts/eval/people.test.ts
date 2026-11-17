import assert from "node:assert/strict";
import test from "node:test";

import { EVAL_TODAY } from "./eve.ts";
import {
  countItems,
  dataProblems,
  emptyJournalOpenerCount,
  itemMatchesTags,
  loadAllPeople,
  personInSweep,
  selectPeople,
} from "./people.ts";
import { conversation, makePerson, opener } from "./test-fixtures.ts";

const noHostPattern =
  /^grief: opener a is marked alsoEmpty, but there is no new-user person/u;
const hostWithEntriesPattern =
  /^new-user: this person stands for the empty journal/u;

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
  // Sam has an opener that also runs on the empty journal, so the person with
  // that journal is covered too.
  assert.deepEqual(
    selectPeople(people, ["example"]).map((p) => p.id),
    ["new-user", "sam-example"]
  );
});

const emptyOpener = (id: string, tags: string[] = []) => ({
  ...opener(id, tags),
  alsoEmpty: true,
});

test("a sweep that sends openers covers the empty-journal person when a covered person has an alsoEmpty opener it picks", () => {
  const grief = makePerson("grief", {
    openers: [emptyOpener("claire", ["quick"]), opener("other", ["screen"])],
  });
  const newUser = makePerson("new-user", {
    entries: 0,
    openers: [opener("gate")],
  });
  const other = makePerson("zed", { openers: [opener("z", ["slow"])] });
  const people = [grief, newUser, other];
  // new-user has nothing tagged quick, but grief's alsoEmpty opener runs on its Sage.
  assert.deepEqual(
    selectPeople(people, ["quick"]).map((p) => p.id),
    ["grief", "new-user"]
  );
  // The people keep their order.
  assert.deepEqual(
    selectPeople([newUser, grief], ["quick"]).map((p) => p.id),
    ["new-user", "grief"]
  );
  // No alsoEmpty opener matches the tags, so new-user is not needed.
  assert.deepEqual(
    selectPeople(people, ["screen"]).map((p) => p.id),
    ["grief"]
  );
  // A sweep with no openers does not need it either.
  assert.deepEqual(
    selectPeople(people, ["quick"], { openers: false }).map((p) => p.id),
    ["grief"]
  );
  // Nobody to add when there is no empty-journal person.
  assert.deepEqual(
    selectPeople([grief, other], ["quick"]).map((p) => p.id),
    ["grief"]
  );
});

test("the empty-journal person's opener count includes the alsoEmpty openers it runs for others", () => {
  const grief = makePerson("grief", {
    openers: [emptyOpener("a", ["screen"]), emptyOpener("b")],
  });
  const newUser = makePerson("new-user", {
    entries: 0,
    openers: [opener("gate", ["screen"])],
  });
  assert.equal(
    emptyJournalOpenerCount(newUser, [grief, newUser], ["screen"]),
    1
  );
  assert.equal(emptyJournalOpenerCount(newUser, [grief, newUser], []), 2);
  assert.equal(emptyJournalOpenerCount(grief, [grief, newUser], []), 0);
  assert.equal(
    countItems(newUser, ["screen"], 1).openers,
    2,
    "its own screen opener and one for grief"
  );
  assert.equal(countItems(newUser, ["screen"]).openers, 1);
});

test("dataProblems flags an alsoEmpty opener with no empty-journal person, and an empty-journal person with entries", () => {
  const grief = makePerson("grief", { openers: [emptyOpener("a")] });
  const missing = dataProblems([grief], EVAL_TODAY);
  assert.equal(missing.length, 1);
  assert.match(missing[0] ?? "", noHostPattern);

  const newUser = makePerson("new-user", { entries: 0 });
  assert.deepEqual(dataProblems([grief, newUser], EVAL_TODAY), []);

  const full = makePerson("new-user", { entries: 2 });
  const problems = dataProblems([grief, full], EVAL_TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", hostWithEntriesPattern);
});

test("on the real people, new-user is covered by the screen sweep and its alsoEmpty openers are counted", async () => {
  const people = await loadAllPeople();
  const covered = selectPeople(people, ["screen"]);
  const newUser = covered.find((person) => person.id === "new-user");
  assert.ok(newUser);
  const extra = emptyJournalOpenerCount(newUser, covered, ["screen"]);
  assert.ok(extra >= 1, "some screen opener is marked alsoEmpty");
  assert.equal(
    countItems(newUser, ["screen"], extra).openers,
    countItems(newUser, ["screen"]).openers + extra
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
