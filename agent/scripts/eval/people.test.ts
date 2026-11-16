import assert from "node:assert/strict";
import test from "node:test";

import { EVAL_TODAY } from "./eve.ts";
import {
  countItems,
  dataProblems,
  emptyJournalConversationCount,
  emptyJournalOpenerCount,
  itemMatchesTags,
  loadAllPeople,
  personInSweep,
  selectPeople,
} from "./people.ts";
import { conversation, makePerson, opener } from "./test-fixtures.ts";

const noHostPattern =
  /^grief: opener a is marked alsoEmpty, but there is no new-user person/u;
const conversationNeedsSearchPattern =
  /conversations \(in a\): alsoEmpty is set, but search is needed/u;
const noConversationHostPattern =
  /^grief: conversation a is marked alsoEmpty, but there is no new-user person/u;
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

// ---------------------------------------------------------------------------
// People a sweep leaves out
// ---------------------------------------------------------------------------

test("a person whose tags hold an excluded tag is never in the sweep, whatever else matches", () => {
  const sam = makePerson("sam", { openers: [opener("a", ["screen"])] });
  const long = makePerson("long-history", {
    conversations: [conversation("why", 30, ["screen"])],
    openers: [opener("b", ["screen"])],
    tags: ["long"],
  });
  assert.equal(personInSweep(long, [], []), true);
  assert.equal(personInSweep(long, [], ["long"]), false);
  assert.equal(personInSweep(long, ["screen"], ["long"]), false);
  assert.equal(personInSweep(sam, ["screen"], ["long"]), true);
  assert.deepEqual(
    selectPeople([sam, long], []).map((person) => person.id),
    ["sam", "long-history"]
  );
  assert.deepEqual(
    selectPeople([sam, long], [], { excludeTags: ["long"] }).map(
      (person) => person.id
    ),
    ["sam"]
  );
  assert.deepEqual(
    selectPeople([sam, long], ["screen"], { excludeTags: ["long"] }).map(
      (person) => person.id
    ),
    ["sam"]
  );
});

test("an excluded person's alsoEmpty items do not bring the empty-journal person in", () => {
  const long = makePerson("long-history", {
    conversations: [conversation("why", 30, [], { alsoEmpty: true })],
    openers: [emptyOpener("o")],
    tags: ["long"],
  });
  const newUser = makePerson("new-user", { entries: 0 });
  const quiet = makePerson("quiet", { tags: ["quiet"] });
  const all = [long, newUser, quiet];
  assert.deepEqual(
    selectPeople(all, ["quiet"], { conversations: true }).map((p) => p.id),
    ["quiet"]
  );
  // Without the exclusion, long-history is covered by its tag only when asked.
  assert.deepEqual(
    selectPeople(all, ["long"], { conversations: true }).map((p) => p.id),
    ["long-history", "new-user"]
  );
  assert.deepEqual(
    selectPeople(all, ["long"], {
      conversations: true,
      excludeTags: ["long"],
    }).map((p) => p.id),
    []
  );
});

// ---------------------------------------------------------------------------
// Conversations on the empty journal
// ---------------------------------------------------------------------------

test("a sweep that sends conversations covers new-user when a covered person has an alsoEmpty one", () => {
  const grief = makePerson("grief", {
    conversations: [
      conversation("hard-night", 6, ["deep"], { alsoEmpty: true }),
    ],
    tags: ["grief"],
  });
  const newUser = makePerson("new-user", { entries: 0 });
  const people = [grief, newUser];
  assert.deepEqual(
    selectPeople(people, ["grief"]).map((p) => p.id),
    ["grief"]
  );
  assert.deepEqual(
    selectPeople(people, ["grief"], { conversations: true }).map((p) => p.id),
    ["grief", "new-user"]
  );
  assert.deepEqual(
    selectPeople(people, ["grief"], { conversations: false }).map((p) => p.id),
    ["grief"]
  );
});

test("the empty-journal person's conversation counts include the alsoEmpty conversations it runs for others", () => {
  const grief = makePerson("grief", {
    conversations: [
      conversation("a", 6, ["deep"], { alsoEmpty: true }),
      conversation("b", 8, [], { alsoEmpty: true }),
      conversation("c", 10),
    ],
  });
  const newUser = makePerson("new-user", {
    conversations: [conversation("own", 5, ["deep"])],
    entries: 0,
  });
  assert.deepEqual(
    emptyJournalConversationCount(newUser, [grief, newUser], []),
    { conversations: 2, turns: 14 }
  );
  assert.deepEqual(
    emptyJournalConversationCount(newUser, [grief, newUser], ["deep"]),
    { conversations: 1, turns: 6 }
  );
  assert.deepEqual(emptyJournalConversationCount(grief, [grief, newUser], []), {
    conversations: 0,
    turns: 0,
  });
  const counts = countItems(newUser, [], 0, { conversations: 2, turns: 14 });
  assert.equal(counts.conversations, 3);
  assert.equal(counts.conversationTurns, 19);
  assert.equal(countItems(newUser, []).conversations, 1);
});

test("dataProblems flags an alsoEmpty conversation with no empty-journal person", () => {
  const grief = makePerson("grief", {
    conversations: [conversation("a", 6, [], { alsoEmpty: true })],
  });
  const problems = dataProblems([grief], EVAL_TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", noConversationHostPattern);
  assert.deepEqual(
    dataProblems([grief, makePerson("new-user", { entries: 0 })], EVAL_TODAY),
    []
  );
});

test("dataProblems refuses an alsoEmpty conversation that needs a search", () => {
  const grief = makePerson("grief", {
    conversations: [
      conversation("a", 6, [], { alsoEmpty: true, search: "needed" }),
    ],
  });
  const newUser = makePerson("new-user", { entries: 0 });
  const problems = dataProblems([grief, newUser], EVAL_TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", conversationNeedsSearchPattern);
});

test("dataProblems names the person", () => {
  const sam = makePerson("sam", {
    events: [{ entry: "no-such-stem", reference: "x" }],
  });
  const problems = dataProblems([sam], EVAL_TODAY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", pattern1);
});
