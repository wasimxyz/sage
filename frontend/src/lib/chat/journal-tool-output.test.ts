import assert from "node:assert/strict";
import test from "node:test";

import {
  journalEntryOutput,
  journalSearchHits,
  journalSearchQuery,
  journalSearchRange,
  journalSearchSummary,
  readEntryId,
} from "./journal-tool-output.ts";

const now = new Date(2026, 9, 26, 9, 0);

test("journal search output accepts empty and populated result lists", () => {
  assert.deepEqual(journalSearchHits([]), []);
  assert.deepEqual(
    journalSearchHits([
      {
        date: "2026-03-03",
        id: 17,
        score: 0.84,
        snippet: "A week of the same routine.",
        title: "Sunday reset",
      },
    ]),
    [{ date: "2026-03-03", id: 17, title: "Sunday reset" }]
  );
  assert.equal(journalSearchHits([{ id: 0, title: "Bad" }]), null);
  assert.equal(journalSearchHits("nothing"), null);
});

test("journal search output reads the entries of a dated or noted result", () => {
  const entry = { date: "2026-10-04", id: 9, snippet: "Hi.", title: "Walk" };
  assert.deepEqual(
    journalSearchHits({
      entries: [entry],
      range: { from: "2026-10-01", label: "October", to: "2026-10-31" },
      today: "2026-10-26",
    }),
    [{ date: "2026-10-04", id: 9, title: "Walk" }]
  );
  assert.deepEqual(
    journalSearchHits({ entries: [], note: "Try other words." }),
    []
  );
  assert.equal(journalSearchHits({ note: "No entries." }), null);
});

test("journal search query is read only from a string input field", () => {
  assert.equal(journalSearchQuery({ query: "feeling stuck" }), "feeling stuck");
  assert.equal(journalSearchQuery({ query: "  sad  " }), "sad");
  assert.equal(journalSearchQuery({ query: "  " }), null);
  assert.equal(journalSearchQuery({ when: "last week" }), null);
  assert.equal(journalSearchQuery({ query: 4 }), null);
  assert.equal(journalSearchQuery(null), null);
});

test("journal search range comes from a dated result", () => {
  assert.deepEqual(
    journalSearchRange({
      entries: [],
      range: { from: "2026-10-01", label: "October", to: "2026-10-31" },
    }),
    { from: "2026-10-01", to: "2026-10-31" }
  );
  assert.equal(journalSearchRange([]), null);
  assert.equal(journalSearchRange({ entries: [] }), null);
  assert.equal(
    journalSearchRange({ range: { from: "October", to: "2026-10-31" } }),
    null
  );
  assert.equal(
    journalSearchRange({ range: { from: "2026-13-45", to: "2026-10-31" } }),
    null
  );
});

test("the summary row sets apart only the words searched for", () => {
  assert.deepEqual(journalSearchSummary("sad, low", null, now), {
    lead: "Searched for ",
    query: "“sad, low”",
    rest: "",
  });
});

test("a date-only summary is one plain run of text", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  assert.deepEqual(journalSearchSummary(null, range, now), {
    lead: "Entries from Thu, Oct 1 to Sat, Oct 31",
    query: null,
    rest: "",
  });
  assert.deepEqual(
    journalSearchSummary(null, { from: "2026-09-27", to: "2026-09-27" }, now),
    { lead: "Entries on Sun, Sep 27", query: null, rest: "" }
  );
});

test("a summary with words and dates puts the dates after the words", () => {
  assert.deepEqual(
    journalSearchSummary("sad", { from: "2026-09-21", to: "2026-09-27" }, now),
    {
      lead: "Searched for ",
      query: "“sad”",
      rest: " from Mon, Sep 21 to Sun, Sep 27",
    }
  );
});

test("a summary adds the year to dates outside this year", () => {
  assert.equal(
    journalSearchSummary(null, { from: "2025-12-30", to: "2026-01-02" }, now)
      ?.lead,
    "Entries from Tue, Dec 30, 2025 to Fri, Jan 2"
  );
});

test("a search with no words and no dates has no summary row", () => {
  assert.equal(journalSearchSummary(null, null, now), null);
});

test("journal entry output needs an id, a title, and a date", () => {
  const entry = {
    body: "The rain stopped before morning.",
    bodyFormat: "plain",
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  };
  assert.deepEqual(journalEntryOutput(entry), {
    date: "2026-03-03",
    id: 17,
    title: "Sunday reset",
  });
  assert.equal(journalEntryOutput({ ...entry, id: -1 }), null);
  assert.equal(journalEntryOutput({ ...entry, title: undefined }), null);
  assert.equal(journalEntryOutput("not an entry"), null);
});

test("journal tool output reads entry-12 ids and the plain ids of older chats", () => {
  assert.equal(readEntryId("entry-17"), 17);
  assert.equal(readEntryId(17), 17);
  assert.equal(readEntryId("chat-17"), null);
  assert.equal(readEntryId("17"), null);
  assert.equal(readEntryId("entry-0"), null);
  assert.deepEqual(
    journalSearchHits([{ date: "2026-03-03", id: "entry-17", title: "Walk" }]),
    [{ date: "2026-03-03", id: 17, title: "Walk" }]
  );
  assert.deepEqual(
    journalEntryOutput({ date: "2026-03-03", id: "entry-17", title: "Walk" }),
    { date: "2026-03-03", id: 17, title: "Walk" }
  );
  assert.equal(
    journalEntryOutput({ date: "2026-03-03", id: "chat-17", title: "Walk" }),
    null
  );
});

test("a date-only summary can name chats instead of entries", () => {
  assert.deepEqual(
    journalSearchSummary(
      null,
      { from: "2026-10-19", to: "2026-10-25" },
      now,
      "Chats"
    )?.lead.startsWith("Chats from "),
    true
  );
});
