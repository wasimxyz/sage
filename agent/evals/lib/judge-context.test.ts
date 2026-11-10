import assert from "node:assert/strict";
import test from "node:test";

import {
  formatJournalContext,
  type JournalContextSource,
} from "./judge-context.ts";

const miaLinePattern =
  /- Mia: former best friend, she\/her, alive\. Note: 'Lost Mia' means the friendship ended/u;
const entryOnePattern =
  /## Entry 1: 2026-07-12, "Lisbon" \(2026-07-12-lisbon\)\n\nJordan proposed in Lisbon\./u;

const factSheetHeadingPattern = /^# Fact sheet for engaged\n/u;
const todayLinePattern = /Today is 2026-11-15 in this journal\./u;
const aboutLinePattern = /About the author: 29, engaged to Jordan in July\./u;
const jordanLinePattern = /- Jordan: fiancé, he\/him, alive\./u;
const biscuitLinePattern = /- Biscuit: dog, died\./u;
const timelineLinePattern = /- 2026-07-12 \(big\): Jordan proposed in Lisbon/u;
const nobodyListedPattern = /- \(nobody listed\)/u;
const nothingListedPattern = /- \(nothing listed\)/u;
const emptyJournalPattern = /The journal is empty\./u;
const todayWordsPattern = /Today is/u;

const person: JournalContextSource = {
  entries: [
    {
      body: "Jordan proposed in Lisbon.\n",
      date: "2026-07-12",
      index: 1,
      stem: "2026-07-12-lisbon",
      title: "Lisbon",
    },
    {
      body: "Rent went up 15%.",
      date: "2026-09-03",
      index: 2,
      stem: "2026-09-03-rent",
      title: "Rent",
    },
  ],
  id: "engaged",
  personCase: {
    about: "29, engaged to Jordan in July.",
    cast: [
      { alive: true, name: "Jordan", pronouns: "he/him", relation: "fiancé" },
      {
        alive: true,
        name: "Mia",
        note: "'Lost Mia' means the friendship ended",
        pronouns: "she/her",
        relation: "former best friend",
      },
      { alive: false, name: "Biscuit", relation: "dog" },
    ],
    timeline: [
      { date: "2026-07-12", weight: "big", what: "Jordan proposed in Lisbon" },
    ],
  },
};

test("the context holds the fact sheet and every entry in order", () => {
  const text = formatJournalContext(person, { today: "2026-11-15" });
  assert.match(text, factSheetHeadingPattern);
  assert.match(text, todayLinePattern);
  assert.match(text, aboutLinePattern);
  assert.match(text, jordanLinePattern);
  assert.match(text, miaLinePattern);
  assert.match(text, biscuitLinePattern);
  assert.match(text, timelineLinePattern);
  assert.match(text, entryOnePattern);
  assert.ok(text.indexOf("## Entry 1") < text.indexOf("## Entry 2"));
  assert.ok(text.endsWith("Rent went up 15%.\n"));
});

test("the same person gives the same text, so the prefix can be cached", () => {
  assert.equal(
    formatJournalContext(person, { today: "2026-11-15" }),
    formatJournalContext(structuredClone(person), { today: "2026-11-15" })
  );
});

test("an empty journal says so, and an empty cast and timeline are marked", () => {
  const text = formatJournalContext({
    entries: [],
    id: "new-user",
    personCase: { about: "Just started.", cast: [], timeline: [] },
  });
  assert.match(text, nobodyListedPattern);
  assert.match(text, nothingListedPattern);
  assert.match(text, emptyJournalPattern);
  assert.doesNotMatch(text, todayWordsPattern);
});
