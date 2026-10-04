import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLastEdited,
  formatRelativeAge,
  formatRelativeCalendarAge,
} from "./format-relative-age.ts";

const now = Date.parse("2026-09-19T17:00:00");

test("formatRelativeAge uses minutes, hours, and days", () => {
  assert.equal(formatRelativeAge("2026-09-19T16:50:00", now), "10m");
  assert.equal(formatRelativeAge("2026-09-19T14:00:00", now), "3h");
  assert.equal(formatRelativeAge("2026-09-14T17:00:00", now), "5d");
});

test("formatRelativeAge switches to weeks after a week", () => {
  assert.equal(formatRelativeAge("2026-09-12T17:00:00", now), "1w");
  assert.equal(formatRelativeAge("2026-08-29T17:00:00", now), "3w");
});

test("formatRelativeAge uses months and years for older timestamps", () => {
  assert.equal(formatRelativeAge("2026-07-19T17:00:00", now), "2mo");
  assert.equal(formatRelativeAge("2025-09-19T17:00:00", now), "1y");
});

test("formatRelativeAge treats a calendar day as calendar age", () => {
  assert.equal(formatRelativeAge("2026-09-19", now), "Today");
  assert.equal(formatRelativeAge("2026-08-29", now), "3w");
});

test("formatRelativeCalendarAge counts whole days", () => {
  assert.equal(formatRelativeCalendarAge("2026-09-19", now), "Today");
  assert.equal(formatRelativeCalendarAge("2026-09-18", now), "1d");
  assert.equal(formatRelativeCalendarAge("2026-09-13", now), "6d");
  assert.equal(formatRelativeCalendarAge("2026-09-12", now), "1w");
  assert.equal(formatRelativeCalendarAge("2026-08-29", now), "3w");
  assert.equal(formatRelativeCalendarAge("2026-07-19", now), "2mo");
});

test("formatLastEdited uses days, weeks, months, and years", () => {
  assert.equal(
    formatLastEdited("2026-09-19T16:59:30", now),
    "Last edited just now"
  );
  assert.equal(
    formatLastEdited("2026-09-19T16:50:00", now),
    "Last edited 10 minutes ago"
  );
  assert.equal(
    formatLastEdited("2026-09-19T14:00:00", now),
    "Last edited 3 hours ago"
  );
  assert.equal(
    formatLastEdited("2026-09-16T17:00:00", now),
    "Last edited 3 days ago"
  );
  assert.equal(
    formatLastEdited("2026-09-12T17:00:00", now),
    "Last edited 1 week ago"
  );
  assert.equal(
    formatLastEdited("2026-08-29T17:00:00", now),
    "Last edited 3 weeks ago"
  );
  assert.equal(
    formatLastEdited("2026-07-19T17:00:00", now),
    "Last edited 2 months ago"
  );
  assert.equal(
    formatLastEdited("2025-09-19T17:00:00", now),
    "Last edited 1 year ago"
  );
});

test("formatLastEdited hides the migration epoch timestamp", () => {
  assert.equal(formatLastEdited("1970-01-01T00:00:00.000Z", now), "");
});
