import assert from "node:assert/strict";
import test from "node:test";

import {
  describeToday,
  rangeFromWhen,
  resolveWhen,
  todayFromEnv,
} from "../agent/lib/when.ts";

// Sunday, so the Monday-to-Sunday week edge is in play.
const sunday = "2026-10-25";
const monday = "2026-10-26";

function span(phrase: string, today = sunday): string {
  const result = resolveWhen(phrase, today);
  if ("error" in result) {
    return `error: ${result.error}`;
  }
  return `${result.range.from}..${result.range.to}`;
}

const couldNotReadWheneverPattern = /Couldn't read "whenever" as a date/;
const couldNotReadPattern =
  /^error: Couldn't read ".*" as a date\. Pass when as YYYY-MM-DD\.\.YYYY-MM-DD\.$/;

test("single days", () => {
  assert.equal(span("today"), "2026-10-25..2026-10-25");
  assert.equal(span("yesterday"), "2026-10-24..2026-10-24");
});

test("recently and lately are the last 14 days", () => {
  assert.equal(span("recently"), "2026-10-12..2026-10-25");
  assert.equal(span("lately"), "2026-10-12..2026-10-25");
});

test("weeks run Monday to Sunday", () => {
  assert.equal(span("this week"), "2026-10-19..2026-10-25");
  assert.equal(span("last week"), "2026-10-12..2026-10-18");
  assert.equal(span("this week", monday), "2026-10-26..2026-10-26");
  assert.equal(span("last week", monday), "2026-10-19..2026-10-25");
});

test("past week is the last seven days, not a calendar week", () => {
  assert.equal(span("past week"), "2026-10-19..2026-10-25");
  assert.equal(span("past 7 days"), "2026-10-19..2026-10-25");
  assert.equal(span("past week", "2026-10-28"), "2026-10-22..2026-10-28");
});

test("rolling spans with a count", () => {
  assert.equal(span("last 3 days"), "2026-10-23..2026-10-25");
  assert.equal(span("past three days"), "2026-10-23..2026-10-25");
  assert.equal(span("the past 2 weeks"), "2026-10-12..2026-10-25");
  assert.equal(span("last couple of weeks"), "2026-10-12..2026-10-25");
  assert.equal(span("past 2 months"), "2026-08-26..2026-10-25");
  assert.equal(span("past year"), "2025-10-26..2026-10-25");
});

test("months and years", () => {
  assert.equal(span("this month"), "2026-10-01..2026-10-25");
  assert.equal(span("last month"), "2026-09-01..2026-09-30");
  assert.equal(span("this year"), "2026-01-01..2026-10-25");
  assert.equal(span("last year"), "2025-01-01..2025-12-31");
  assert.equal(span("last month", "2026-01-05"), "2025-12-01..2025-12-31");
});

test("N units ago covers the whole day, week, month, or year", () => {
  assert.equal(span("3 days ago"), "2026-10-22..2026-10-22");
  assert.equal(span("a week ago"), "2026-10-12..2026-10-18");
  assert.equal(span("2 weeks ago"), "2026-10-05..2026-10-11");
  assert.equal(span("three weeks ago"), "2026-09-28..2026-10-04");
  assert.equal(span("3 months ago"), "2026-07-01..2026-07-31");
  assert.equal(span("a year ago"), "2025-01-01..2025-12-31");
});

test("a month ago clamps to the length of the shorter month", () => {
  assert.equal(span("1 month ago", "2026-03-31"), "2026-02-01..2026-02-28");
  assert.equal(span("2 months ago", "2026-03-31"), "2026-01-01..2026-01-31");
  assert.equal(span("1 month ago", "2028-03-31"), "2028-02-01..2028-02-29");
});

test("a month name means the latest one that has started", () => {
  assert.equal(span("March"), "2026-03-01..2026-03-31");
  assert.equal(span("in March"), "2026-03-01..2026-03-31");
  assert.equal(span("mar"), "2026-03-01..2026-03-31");
  assert.equal(span("December"), "2025-12-01..2025-12-31");
  assert.equal(span("October"), "2026-10-01..2026-10-31");
  assert.equal(span("march 2025"), "2025-03-01..2025-03-31");
  assert.equal(span("march of 2025"), "2025-03-01..2025-03-31");
  assert.equal(span("February 2028"), "2028-02-01..2028-02-29");
  assert.equal(span("december", "2026-01-05"), "2025-12-01..2025-12-31");
});

test("last before a month name means one that is over", () => {
  assert.equal(span("last October"), "2025-10-01..2025-10-31");
  assert.equal(span("last March"), "2026-03-01..2026-03-31");
});

test("seasons", () => {
  assert.equal(span("summer"), "2026-06-01..2026-08-31");
  assert.equal(span("spring 2025"), "2025-03-01..2025-05-31");
  assert.equal(span("fall"), "2026-09-01..2026-11-30");
  assert.equal(span("autumn"), "2026-09-01..2026-11-30");
  assert.equal(span("last fall"), "2025-09-01..2025-11-30");
});

test("winter belongs to the year it ends in", () => {
  assert.equal(span("winter"), "2025-12-01..2026-02-28");
  assert.equal(span("winter 2026"), "2025-12-01..2026-02-28");
  assert.equal(span("winter 2028"), "2027-12-01..2028-02-29");
  assert.equal(span("winter", "2026-01-05"), "2025-12-01..2026-02-28");
  assert.equal(span("last winter", "2026-01-05"), "2024-12-01..2025-02-28");
});

test("a weekday is the latest one before today", () => {
  assert.equal(span("friday"), "2026-10-23..2026-10-23");
  assert.equal(span("last monday"), "2026-10-19..2026-10-19");
  assert.equal(span("on Sunday"), "2026-10-18..2026-10-18");
  assert.equal(span("sunday", monday), "2026-10-25..2026-10-25");
});

test("ISO years, months, days, and ranges", () => {
  assert.equal(span("2025"), "2025-01-01..2025-12-31");
  assert.equal(span("2026-03"), "2026-03-01..2026-03-31");
  assert.equal(span("2026-03-14"), "2026-03-14..2026-03-14");
  assert.equal(span("2026-03-01..2026-03-15"), "2026-03-01..2026-03-15");
  assert.equal(span("2025..2026-03"), "2025-01-01..2026-03-31");
  assert.equal(span("2026-03-01 to 2026-03-15"), "2026-03-01..2026-03-15");
  assert.equal(span("from 2026-03-01 to 2026-03-15"), "2026-03-01..2026-03-15");
});

test("case, spacing, and trailing punctuation do not matter", () => {
  assert.equal(span("  Last   Week. "), "2026-10-12..2026-10-18");
  assert.equal(span("In The Past Week?"), "2026-10-19..2026-10-25");
});

test("the label keeps the words that were passed", () => {
  const result = resolveWhen("  last week ", sunday);
  assert.deepEqual(result, {
    range: { from: "2026-10-12", label: "last week", to: "2026-10-18" },
  });
});

test("a phrase that cannot be read asks for ISO dates", () => {
  for (const phrase of [
    "whenever",
    "next week",
    "constructor",
    "toString",
    "0 days ago",
    "march 32",
    "february 30",
    "",
  ]) {
    assert.match(span(phrase), couldNotReadPattern);
  }
});

test("the last week, month, or year is a rolling span", () => {
  assert.equal(span("in the last week"), "2026-10-19..2026-10-25");
  assert.equal(span("the last week", "2026-10-28"), "2026-10-22..2026-10-28");
  assert.equal(span("over the last month"), "2026-09-26..2026-10-25");
  assert.equal(span("within the last year"), "2025-10-26..2026-10-25");
  assert.equal(span("in the last 3 days"), "2026-10-23..2026-10-25");
  // Without "the", last is the calendar unit before this one.
  assert.equal(span("in last week"), "2026-10-12..2026-10-18");
  assert.equal(span("last month"), "2026-09-01..2026-09-30");
});

test("a few means three", () => {
  assert.equal(span("the last few days"), "2026-10-23..2026-10-25");
  assert.equal(span("past few weeks"), "2026-10-05..2026-10-25");
});

test("quotes and a comma before the year do not matter", () => {
  assert.equal(span('"last week"'), "2026-10-12..2026-10-18");
  assert.equal(span("'in March.'"), "2026-03-01..2026-03-31");
  assert.equal(span("march, 2025"), "2025-03-01..2025-03-31");
  assert.equal(span("summer, 2025"), "2025-06-01..2025-08-31");
});

test("a month and a day is one day", () => {
  assert.equal(span("March 3"), "2026-03-03..2026-03-03");
  assert.equal(span("on march 3rd"), "2026-03-03..2026-03-03");
  assert.equal(span("3 March"), "2026-03-03..2026-03-03");
  assert.equal(span("the 3rd of March"), "2026-03-03..2026-03-03");
  assert.equal(span("March 3, 2025"), "2025-03-03..2025-03-03");
  assert.equal(span("march 3 2025"), "2025-03-03..2025-03-03");
  // A day that has not come yet this year means last year's.
  assert.equal(span("march 30", "2026-03-10"), "2025-03-30..2025-03-30");
  assert.equal(span("march 10", "2026-03-10"), "2026-03-10..2026-03-10");
  // Leap day reaches back to the last one.
  assert.equal(span("feb 29"), "2024-02-29..2024-02-29");
  assert.match(span("feb 29 2026"), couldNotReadPattern);
});

test("a weekend is Saturday and Sunday", () => {
  // Sunday 2026-10-25: this week began on Monday the 19th.
  assert.equal(span("last weekend"), "2026-10-17..2026-10-18");
  assert.equal(span("this weekend"), "2026-10-24..2026-10-25");
  assert.equal(span("this past weekend"), "2026-10-24..2026-10-25");
  assert.equal(span("last weekend", monday), "2026-10-24..2026-10-25");
  assert.equal(span("this past weekend", monday), "2026-10-24..2026-10-25");
  // Wednesday: this weekend has not happened, last one has.
  assert.equal(span("last weekend", "2026-10-28"), "2026-10-24..2026-10-25");
  assert.equal(
    span("this past weekend", "2026-10-28"),
    "2026-10-24..2026-10-25"
  );
  assert.match(span("this weekend", "2026-10-28"), couldNotReadPattern);
  // Saturday: only the Saturday has come.
  assert.equal(span("this weekend", "2026-10-24"), "2026-10-24..2026-10-24");
});

test("this season and earlier this week", () => {
  assert.equal(span("this summer"), "2026-06-01..2026-08-31");
  assert.equal(span("this past summer"), "2026-06-01..2026-08-31");
  assert.equal(span("earlier this week"), "2026-10-19..2026-10-25");
  assert.equal(span("earlier this month"), "2026-10-01..2026-10-25");
});

test("since runs from the start of a time to today", () => {
  assert.equal(span("since March"), "2026-03-01..2026-10-25");
  assert.equal(span("since last month"), "2026-09-01..2026-10-25");
  assert.equal(span("since monday"), "2026-10-19..2026-10-25");
  assert.equal(span("since 2026-03-14"), "2026-03-14..2026-10-25");
  assert.equal(span("since march 3"), "2026-03-03..2026-10-25");
  assert.match(span("since 2027"), couldNotReadPattern);
  assert.match(span("since whenever"), couldNotReadPattern);
});

test("a range with nothing after the dots is not one day", () => {
  assert.equal(
    span("2026-03-01.."),
    'error: "2026-03-01.." is missing the date after "..". Pass when as YYYY-MM-DD..YYYY-MM-DD.'
  );
  assert.match(span("..2026-03-01"), couldNotReadPattern);
  // A trailing full stop still does not matter.
  assert.equal(span("2026-03-01."), "2026-03-01..2026-03-01");
});

test("a year with fewer than four real digits cannot be read", () => {
  assert.match(span("march 0050"), couldNotReadPattern);
  assert.match(span("summer 0050"), couldNotReadPattern);
  assert.match(span("march 3 0050"), couldNotReadPattern);
});

test("impossible dates cannot be read", () => {
  assert.match(span("2026-13"), couldNotReadPattern);
  assert.match(span("2026-02-30"), couldNotReadPattern);
  assert.match(span("2026-03-01..2026-02-30"), couldNotReadPattern);
});

test("a range that ends before it starts is an error", () => {
  assert.equal(
    span("2026-03-15..2026-03-01"),
    'error: "2026-03-15..2026-03-01" starts after it ends. Put the earlier date first.'
  );
});

test("a bad today is reported", () => {
  assert.equal(
    span("today", "yesterday"),
    'error: Today\'s date "yesterday" is not YYYY-MM-DD.'
  );
});

test("todayFromEnv uses SAGE_TODAY when it is a real date", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(todayFromEnv({ SAGE_TODAY: "2026-11-15" }, now), "2026-11-15");
  assert.equal(todayFromEnv({ SAGE_TODAY: " 2026-11-15 " }, now), "2026-11-15");
});

test("todayFromEnv falls back to the local date", () => {
  const now = new Date(2026, 0, 2, 23, 59, 59);
  assert.equal(todayFromEnv({}, now), "2026-01-02");
  assert.equal(todayFromEnv({ SAGE_TODAY: "" }, now), "2026-01-02");
  assert.equal(todayFromEnv({ SAGE_TODAY: "2026-02-30" }, now), "2026-01-02");
  assert.equal(todayFromEnv({ SAGE_TODAY: "soon" }, now), "2026-01-02");
});

test("describeToday names the weekday", () => {
  assert.equal(describeToday(sunday), "Today is Sunday, October 25, 2026.");
  assert.equal(
    describeToday("2026-11-15"),
    "Today is Sunday, November 15, 2026."
  );
  assert.equal(describeToday("nope"), "");
});

test("rangeFromWhen is null for no words and throws for unreadable ones", () => {
  assert.equal(rangeFromWhen("", sunday), null);
  assert.equal(rangeFromWhen("   ", sunday), null);
  assert.deepEqual(rangeFromWhen(" last week ", sunday), {
    from: "2026-10-12",
    label: "last week",
    to: "2026-10-18",
  });
  assert.throws(
    () => rangeFromWhen("whenever", sunday),
    couldNotReadWheneverPattern
  );
});
