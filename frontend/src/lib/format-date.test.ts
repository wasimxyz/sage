import assert from "node:assert/strict";
import test from "node:test";

import { formatJournalListDate, localDateKey } from "./format-date.ts";

test("localDateKey gives the local day of a UTC instant", () => {
  // Built from local parts, so the answer does not depend on the time zone
  // the tests run in.
  const lateEvening = new Date(2026, 9, 2, 23, 30).toISOString();
  const justAfterMidnight = new Date(2026, 9, 3, 0, 30).toISOString();
  assert.equal(localDateKey(lateEvening), "2026-10-02");
  assert.equal(localDateKey(justAfterMidnight), "2026-10-03");
});

test("localDateKey leaves a value that is not a date alone", () => {
  assert.equal(localDateKey("not a date"), "not a date");
  assert.equal(localDateKey(""), "");
});

test("a chat saved this evening reads Today in the list", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  const savedLastNight = new Date(2026, 9, 17, 23, 30).toISOString();
  const savedThisMorning = new Date(2026, 9, 18, 0, 30).toISOString();
  assert.equal(
    formatJournalListDate(localDateKey(savedLastNight), now),
    "Yesterday"
  );
  assert.equal(
    formatJournalListDate(localDateKey(savedThisMorning), now),
    "Today"
  );
});
