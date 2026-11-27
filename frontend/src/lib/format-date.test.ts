import assert from "node:assert/strict";
import test from "node:test";

import {
  formatEntryDate,
  formatShortEntryDate,
  formatSidebarDate,
  formatTodayHeading,
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

test("a chat saved this evening reads Today in the sidebar", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  const savedLastNight = new Date(2026, 9, 17, 23, 30).toISOString();
  const savedThisMorning = new Date(2026, 9, 18, 0, 30).toISOString();
  assert.equal(
    formatSidebarDate(localDateKey(savedLastNight), now),
    "Yesterday"
  );
  assert.equal(formatSidebarDate(localDateKey(savedThisMorning), now), "Today");
});

test("formatEntryDate leads with the weekday unless asked not to", () => {
  assert.equal(formatEntryDate("2026-11-30"), "Monday, November 30, 2026");
  assert.equal(
    formatEntryDate("2026-11-30", { weekday: false }),
    "November 30, 2026"
  );
});

test("an older date in the sidebar is short, with the year when it is not this one", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(formatSidebarDate("2026-10-04", now), "Oct 4");
  assert.equal(formatSidebarDate("2026-01-02", now), "Jan 2");
  assert.equal(formatSidebarDate("2025-11-28", now), "Nov 28, 2025");
});

test("a day ahead in the sidebar reads as a short date", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(formatSidebarDate("2026-10-19", now), "Oct 19");
  assert.equal(formatSidebarDate("2027-01-02", now), "Jan 2, 2027");
});

test("a recent date in the sidebar reads in words", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(formatSidebarDate("2026-10-18", now), "Today");
  assert.equal(formatSidebarDate("2026-10-17", now), "Yesterday");
  assert.equal(formatSidebarDate("2026-10-15", now), "3 days ago");
  assert.equal(formatSidebarDate("2026-10-12", now), "6 days ago");
  assert.equal(formatSidebarDate("2026-10-11", now), "1 week ago");
  assert.equal(formatSidebarDate("2026-10-05", now), "1 week ago");
  assert.equal(formatSidebarDate("2026-10-04", now), "Oct 4");
});

test("today's heading names the weekday, month, and day", () => {
  assert.equal(
    formatTodayHeading(new Date(2026, 10, 23, 18)),
    "Monday, November 23"
  );
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
