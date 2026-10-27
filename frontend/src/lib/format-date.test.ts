import assert from "node:assert/strict";
import test from "node:test";

import {
  formatEntryDate,
  formatJournalListDate,
  formatShortEntryDate,
  localDateKey,
  msUntilNextDay,
} from "./format-date.ts";

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

test("formatEntryDate leads with the weekday unless asked not to", () => {
  assert.equal(formatEntryDate("2026-11-30"), "Monday, November 30, 2026");
  assert.equal(
    formatEntryDate("2026-11-30", { weekday: false }),
    "November 30, 2026"
  );
});

test("an older date in the list shows the weekday", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(formatJournalListDate("2026-10-02", now), "Friday, Oct 2");
  assert.equal(
    formatJournalListDate("2025-11-28", now),
    "Friday, Nov 28, 2025"
  );
  assert.equal(
    formatJournalListDate("2026-11-30", now),
    "Monday, November 30, 2026"
  );
});

test("a relative date in the list has no weekday", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(formatJournalListDate("2026-10-18", now), "Today");
  assert.equal(formatJournalListDate("2026-10-17", now), "Yesterday");
  assert.equal(formatJournalListDate("2026-10-13", now), "5 days ago");
  assert.equal(formatJournalListDate("2026-10-08", now), "1 week ago");
});

test("msUntilNextDay counts down to the next local midnight", () => {
  assert.equal(msUntilNextDay(new Date(2026, 9, 18, 23, 59, 30)), 30_000);
  assert.equal(msUntilNextDay(new Date(2026, 9, 18, 0, 0, 0)), 24 * 3_600_000);
});

test("formatShortEntryDate gives a weekday and day, and a year when it is not this one", () => {
  const now = new Date(2026, 9, 26, 9, 0);
  assert.equal(formatShortEntryDate("2026-09-27", now), "Sun, Sep 27");
  assert.equal(formatShortEntryDate("2025-09-27", now), "Sat, Sep 27, 2025");
  assert.equal(
    formatShortEntryDate("2026-09-27T08:00:00Z", now),
    "Sun, Sep 27"
  );
  assert.equal(formatShortEntryDate("last week", now), "last week");
});
