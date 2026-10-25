import assert from "node:assert/strict";
import test from "node:test";

import {
  greetingFor,
  groupHomeItems,
  type HomeChat,
  type HomeEntry,
  homeRowDate,
  monthAgoEntry,
  monthAgoLine,
  monthDays,
  monthName,
  nextGreetingChange,
  nextHomeChange,
  weekStartsOnFrom,
} from "./home.ts";

// Every instant is built from local parts, so the answers do not depend on the
// time zone the tests run in.
function entry(
  id: number,
  date: string,
  title = `Entry ${id}`,
  updatedAt?: Date
): HomeEntry {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return {
    date,
    id,
    title,
    updatedAt: (updatedAt ?? new Date(year, month - 1, day, 12)).toISOString(),
  };
}

function chat(id: number, at: Date, title = `Chat ${id}`): HomeChat {
  return { id, title, updatedAt: at.toISOString() };
}

function ids(rows: { id: number; kind: string }[]): string[] {
  return rows.map((row) => `${row.kind}-${row.id}`);
}

test("the greeting follows the hour", () => {
  const at = (hour: number, minute: number) =>
    greetingFor(new Date(2026, 9, 24, hour, minute));
  assert.equal(at(4, 59), "Good evening.");
  assert.equal(at(5, 0), "Good morning.");
  assert.equal(at(11, 59), "Good morning.");
  assert.equal(at(12, 0), "Good afternoon.");
  assert.equal(at(16, 59), "Good afternoon.");
  assert.equal(at(17, 0), "Good evening.");
  assert.equal(at(0, 0), "Good evening.");
});

test("the greeting changes at 5 AM, noon, and 5 PM", () => {
  const next = (hour: number, minute = 0) =>
    nextGreetingChange(new Date(2026, 9, 24, hour, minute));
  assert.deepEqual(next(3), new Date(2026, 9, 24, 5));
  assert.deepEqual(next(5), new Date(2026, 9, 24, 12));
  assert.deepEqual(next(11, 59), new Date(2026, 9, 24, 12));
  assert.deepEqual(next(16, 59), new Date(2026, 9, 24, 17));
  assert.deepEqual(next(17), new Date(2026, 9, 25, 5));
  assert.deepEqual(
    nextGreetingChange(new Date(2026, 11, 31, 23)),
    new Date(2027, 0, 1, 5)
  );
});

test("Home's labels turn over at the next greeting or at midnight", () => {
  assert.deepEqual(
    nextHomeChange(new Date(2026, 9, 24, 13)),
    new Date(2026, 9, 24, 17)
  );
  assert.deepEqual(
    nextHomeChange(new Date(2026, 9, 24, 17, 30)),
    new Date(2026, 9, 25)
  );
  assert.deepEqual(
    nextHomeChange(new Date(2026, 9, 24, 23, 59)),
    new Date(2026, 9, 25)
  );
  assert.deepEqual(
    nextHomeChange(new Date(2026, 9, 24, 0, 30)),
    new Date(2026, 9, 24, 5)
  );
});

test("the month's name is in English", () => {
  assert.equal(monthName(new Date(2026, 9, 24)), "October");
  assert.equal(monthName(new Date(2026, 8, 1)), "September");
});

test("the month-ago entry is the newest on the same day last month", () => {
  const now = new Date(2026, 9, 24, 21, 22);
  const found = monthAgoEntry(
    [
      entry(3, "2026-09-24", "Things I want to get better at"),
      entry(9, "2026-09-24", "Later that day"),
      entry(5, "2026-09-23"),
      entry(7, "2026-10-24"),
    ],
    now
  );
  assert.equal(found?.id, 9);
});

test("there is no month-ago entry when none was written that day", () => {
  const now = new Date(2026, 9, 24);
  assert.equal(monthAgoEntry([], now), null);
  assert.equal(monthAgoEntry([entry(1, "2026-09-25")], now), null);
});

test("the month-ago entry is hidden when last month has no such day", () => {
  const now = new Date(2026, 2, 31);
  assert.equal(monthAgoEntry([entry(1, "2026-02-28")], now), null);
  assert.equal(
    monthAgoEntry([entry(2, "2026-02-28")], new Date(2026, 2, 28))?.id,
    2
  );
});

test("the month-ago entry reaches back across the new year", () => {
  const now = new Date(2027, 0, 15);
  assert.equal(monthAgoEntry([entry(4, "2026-12-15")], now)?.id, 4);
});

test("the month-ago line quotes the title and ends the sentence", () => {
  assert.equal(
    monthAgoLine("Things I want to get better at"),
    "A month ago today, you wrote “Things I want to get better at.”"
  );
  assert.equal(
    monthAgoLine("Why am I like this?"),
    "A month ago today, you wrote “Why am I like this?”"
  );
  assert.equal(monthAgoLine("   "), "A month ago today, you wrote “Untitled.”");
});

test("the month row has one square for each day", () => {
  const now = new Date(2026, 9, 24, 21, 22);
  const days = monthDays(
    [entry(1, "2026-10-19"), entry(2, "2026-10-19"), entry(3, "2026-10-24")],
    now
  );
  assert.equal(days.length, 31);
  assert.equal(days[0]?.date, "2026-10-01");
  assert.equal(days[30]?.date, "2026-10-31");
  assert.equal(monthDays([], new Date(2026, 1, 3)).length, 28);
  assert.equal(monthDays([], new Date(2028, 1, 3)).length, 29);
});

test("a day with an entry is written, and opens its newest entry", () => {
  const now = new Date(2026, 9, 24);
  const days = monthDays([entry(1, "2026-10-19"), entry(8, "2026-10-19")], now);
  const [day] = days.slice(18, 19);
  assert.equal(day?.state, "written");
  assert.equal(day?.entryId, 8);
  assert.equal(day?.label, "October 19, entry written");
});

test("empty, today, and future days are told apart", () => {
  const now = new Date(2026, 9, 24);
  const days = monthDays([entry(3, "2026-10-24")], now);
  assert.equal(days[17]?.state, "empty");
  assert.equal(days[17]?.label, "October 18, no entry");
  assert.equal(days[23]?.today, true);
  assert.equal(days[23]?.label, "October 24, today, entry written");
  assert.equal(days[24]?.state, "future");
  assert.equal(days[24]?.label, "October 25");
  assert.equal(days.filter((day) => day.today).length, 1);
});

test("today with no entry is empty, not future", () => {
  const days = monthDays([], new Date(2026, 9, 24));
  assert.equal(days[23]?.state, "empty");
  assert.equal(days[23]?.label, "October 24, today, no entry");
});

test("an entry dated ahead still fills its square", () => {
  const days = monthDays([entry(6, "2026-10-30")], new Date(2026, 9, 24));
  assert.equal(days[29]?.state, "written");
  assert.equal(days[29]?.label, "October 30, entry written");
});

test("an entry from another month does not fill a square", () => {
  const days = monthDays([entry(6, "2026-09-30")], new Date(2026, 9, 24));
  assert.equal(days.filter((day) => day.state === "written").length, 0);
});

test("the Mac's first weekday maps to date-fns", () => {
  assert.equal(weekStartsOnFrom(1), 0);
  assert.equal(weekStartsOnFrom(2), 1);
  assert.equal(weekStartsOnFrom(7), 6);
  assert.equal(weekStartsOnFrom(0), 0);
  assert.equal(weekStartsOnFrom(8), 0);
  assert.equal(weekStartsOnFrom(1.5), 0);
});

// Saturday, October 24, 2026. A Sunday week starts on October 18, and a Monday
// week on October 19.
const saturday = new Date(2026, 9, 24, 21, 30);

test("entries and chats share Today, This week, and Last week", () => {
  const groups = groupHomeItems(
    [
      entry(1, "2026-10-24", "Random"),
      entry(2, "2026-10-19"),
      entry(3, "2026-10-17"),
      entry(4, "2026-10-11"),
      entry(5, "2026-10-10"),
    ],
    [
      chat(1, new Date(2026, 9, 19, 20, 0)),
      chat(2, new Date(2026, 9, 16, 10, 0)),
    ],
    saturday,
    0
  );
  assert.deepEqual(ids(groups.today), ["entry-1"]);
  assert.deepEqual(ids(groups.thisWeek), ["chat-1", "entry-2"]);
  assert.deepEqual(ids(groups.lastWeek), ["entry-3", "chat-2", "entry-4"]);
});

test("the week starts on the day the Mac says", () => {
  const entries = [entry(1, "2026-10-18"), entry(2, "2026-10-19")];
  const sunday = groupHomeItems(entries, [], saturday, 0);
  assert.deepEqual(ids(sunday.thisWeek), ["entry-2", "entry-1"]);
  assert.deepEqual(ids(sunday.lastWeek), []);
  const monday = groupHomeItems(entries, [], saturday, 1);
  assert.deepEqual(ids(monday.thisWeek), ["entry-2"]);
  assert.deepEqual(ids(monday.lastWeek), ["entry-1"]);
});

test("when today starts the week, This week is empty", () => {
  const sunday = new Date(2026, 9, 25, 9, 0);
  const groups = groupHomeItems(
    [entry(1, "2026-10-25"), entry(2, "2026-10-24"), entry(3, "2026-10-18")],
    [],
    sunday,
    0
  );
  assert.deepEqual(ids(groups.today), ["entry-1"]);
  assert.deepEqual(ids(groups.thisWeek), []);
  assert.deepEqual(ids(groups.lastWeek), ["entry-2", "entry-3"]);
});

test("a chat belongs to the local day it last changed", () => {
  const justAfterMidnight = new Date(2026, 9, 24, 0, 30);
  const lateLastNight = new Date(2026, 9, 23, 23, 30);
  const groups = groupHomeItems(
    [],
    [chat(1, justAfterMidnight), chat(2, lateLastNight)],
    saturday,
    0
  );
  assert.deepEqual(ids(groups.today), ["chat-1"]);
  assert.deepEqual(ids(groups.thisWeek), ["chat-2"]);
});

test("items are newest first, and older and future ones are dropped", () => {
  const groups = groupHomeItems(
    [
      entry(1, "2026-10-24"),
      entry(2, "2026-10-25"),
      entry(3, "2026-09-01"),
      entry(4, "2026-10-17"),
    ],
    [
      chat(7, new Date(2026, 9, 24, 23, 0)),
      chat(8, new Date(2026, 9, 24, 8, 0)),
    ],
    saturday,
    0
  );
  assert.deepEqual(ids(groups.today), ["chat-7", "entry-1", "chat-8"]);
  assert.deepEqual(ids(groups.thisWeek), []);
  assert.deepEqual(ids(groups.lastWeek), ["entry-4"]);
});

test("rows that tie on the day and time put the newest id first", () => {
  const groups = groupHomeItems(
    [entry(1, "2026-10-24"), entry(2, "2026-10-24")],
    [],
    saturday,
    0
  );
  assert.deepEqual(ids(groups.today), ["entry-2", "entry-1"]);
});

test("a row without a title reads Untitled", () => {
  const groups = groupHomeItems(
    [entry(1, "2026-10-24", " ")],
    [chat(1, new Date(2026, 9, 24, 8, 0), "")],
    saturday,
    0
  );
  assert.deepEqual(
    groups.today.map((row) => row.title),
    ["Untitled", "Untitled chat"]
  );
});

test("a row shows the time, the weekday, or a short date", () => {
  const groups = groupHomeItems(
    [
      entry(1, "2026-10-24", "Random", new Date(2026, 9, 24, 21, 22)),
      entry(2, "2026-10-19"),
      entry(3, "2026-10-17"),
    ],
    [],
    saturday,
    0
  );
  const [today] = groups.today;
  const [thisWeek] = groups.thisWeek;
  const [lastWeek] = groups.lastWeek;
  assert.ok(today && thisWeek && lastWeek);
  assert.equal(homeRowDate(today, "today", "en-US"), "9:22 PM");
  assert.equal(homeRowDate(thisWeek, "thisWeek", "en-US"), "Monday");
  assert.equal(homeRowDate(lastWeek, "lastWeek", "en-US"), "Sat, Oct 17");
});
