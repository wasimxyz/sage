import assert from "node:assert/strict";
import test from "node:test";

import { type DatedEntry, localToday, moveToToday } from "./seed-dates.ts";

const msPerDay = 86_400_000;
const notOnCalendarPattern =
  /02-bad\.md has a date that is not on the calendar/;

// Out of order on purpose: the baseline is the latest date, not the last file.
// 2026-10-25 is a Sunday.
const baseline = [
  { date: "2026-07-30", fileName: "01-thursday.md" },
  { date: "2026-10-25", fileName: "02-sunday.md" },
  { date: "2026-08-04", fileName: "03-tuesday.md" },
  { date: "2026-10-22", fileName: "04-thursday.md" },
];

function day(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / msPerDay;
}

function weekday(date: string): number {
  return new Date(day(date) * msPerDay).getUTCDay();
}

function newest(entries: readonly DatedEntry[]): string {
  return (
    entries
      .map((entry) => entry.date)
      .sort()
      .at(-1) ?? ""
  );
}

// Checks what every move must keep, whatever today is.
function assertMoved(
  today: string,
  expectedDays: number,
  expectedNewest: string
) {
  const { days, entries } = moveToToday(baseline, today);

  assert.equal(days, expectedDays);
  assert.ok(days % 7 === 0, "the move is not a whole number of weeks");
  assert.equal(newest(entries), expectedNewest);
  assert.ok(
    day(today) - day(newest(entries)) < 7,
    "newest is not in the last 7 days"
  );
  for (const [index, entry] of entries.entries()) {
    const before = baseline[index];
    assert.equal(entry.fileName, before?.fileName);
    assert.equal(
      weekday(entry.date),
      weekday(before?.date ?? ""),
      `${entry.fileName} changed weekday`
    );
    assert.ok(
      entry.date <= today,
      `${entry.fileName} is in the future: ${entry.date}`
    );
  }
  assert.deepEqual(
    gaps(entries),
    gaps(baseline),
    "a gap between entries changed"
  );
  return entries;
}

// Days from each entry to the next, in file order.
function gaps(entries: readonly DatedEntry[]): number[] {
  const days = entries.map((entry) => day(entry.date));
  return days.slice(1).map((next, index) => next - (days[index] ?? 0));
}

test("today on the baseline's weekday puts the newest entry on today", () => {
  assertMoved("2026-11-08", 14, "2026-11-08");
  assertMoved("2026-10-25", 0, "2026-10-25");
});

test("the day after the baseline's weekday puts the newest entry on yesterday", () => {
  assertMoved("2026-11-09", 14, "2026-11-08");
});

test("the day before the baseline's weekday puts the newest entry 6 days back", () => {
  assertMoved("2026-11-07", 7, "2026-11-01");
});

test("a Wednesday moves a Thursday entry by two weeks", () => {
  const entries = assertMoved("2026-11-11", 14, "2026-11-08");

  assert.equal(entries[0]?.date, "2026-08-13");
});

test("a today before the baseline moves the dates back", () => {
  assertMoved("2026-10-20", -7, "2026-10-18");
});

test("dates move across a year end and a leap day", () => {
  assertMoved("2028-03-01", 70 * 7, "2028-02-27");
});

test("the files keep their order and everything but the date", () => {
  const entries = [
    { body: "First.", date: "2026-10-18", fileName: "01.md", title: "One" },
    { body: "Second.", date: "2026-10-25", fileName: "02.md", title: "Two" },
  ];

  assert.deepEqual(moveToToday(entries, "2026-11-01").entries, [
    { body: "First.", date: "2026-10-25", fileName: "01.md", title: "One" },
    { body: "Second.", date: "2026-11-01", fileName: "02.md", title: "Two" },
  ]);
});

test("a date that is not on the calendar names its file", () => {
  assert.throws(
    () =>
      moveToToday(
        [
          { date: "2026-02-28", fileName: "01-ok.md" },
          { date: "2026-02-30", fileName: "02-bad.md" },
        ],
        "2026-10-25"
      ),
    notOnCalendarPattern
  );
});

test("today is the local calendar day, not the UTC one", () => {
  const zone = process.env.TZ;
  try {
    // 00:30 here is still the day before in UTC.
    process.env.TZ = "Pacific/Kiritimati";
    assert.equal(localToday(new Date(2026, 9, 25, 0, 30)), "2026-10-25");
    // 23:30 here is already the next day in UTC.
    process.env.TZ = "Pacific/Pago_Pago";
    assert.equal(localToday(new Date(2026, 9, 25, 23, 30)), "2026-10-25");
  } finally {
    if (zone === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = zone;
    }
  }
});
