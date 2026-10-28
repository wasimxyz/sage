// Turns the words a person uses for a time ("last week", "in March") into a
// span of calendar days, so the model never does date math itself. Weeks run
// Monday to Sunday. A span never depends on the time of day.

export interface DateRange {
  from: string;
  label: string;
  to: string;
}

export type WhenResult = { range: DateRange } | { error: string };

// Whole days since 1970-01-01, so a span is two integers and the math is
// plain subtraction. Nothing here touches a time zone.
interface Span {
  from: number;
  to: number;
}

type Unit = "day" | "week" | "month" | "year";
type Season = "spring" | "summer" | "fall" | "autumn" | "winter";
type Matcher = (phrase: string, today: number) => Span | null;

const msPerDay = 86_400_000;
const recentDays = 14;
const daysPerWeek = 7;
const monthsPerYear = 12;
const oldestYear = 1000;
const largestCount = 1000;
// Back far enough to pass a skipped leap year (1900, 2100) for a leap day.
const leapDaySearchYears = 8;

const digitsPattern = /^\d+$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoPartsPattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const rangeSeparatorPattern = /\s*\.\.\s*|\s+to\s+/;
const whitespacePattern = /\s+/g;
const leadingQuotesPattern = /^[\s"'`\u201c\u201d\u2018\u2019]+/;
const trailingPunctuationPattern = /[\s.,!?;:"'`\u201c\u201d\u2018\u2019]+$/;
const openRangePattern = /\d\.\.\s*$/;
const leadingWordsPattern =
  /^(?:(?:in|on|during|from|over|within|earlier)\s+)+/;
const theLastPattern = /^the\s+last\s+(?=(?:day|week|month|year)s?$)/;
const leadingArticlePattern = /^the\s+/;
const couplePattern = /\b(?:a\s+)?couple(?:\s+of)?\b/g;
const pastPattern = /^(?:this\s+)?past\s+(?:(\S+)\s+)?(day|week|month|year)s?$/;
const lastCountPattern = /^last\s+(\S+)\s+(day|week|month|year)s?$/;
const agoPattern = /^(\S+)\s+(day|week|month|year)s?\s+ago$/;
const monthPattern = /^(last\s+)?([a-z]+)(?:,?\s+(?:of\s+)?(\d{4}))?$/;
const monthDayPattern =
  /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/;
const dayMonthPattern =
  /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:,?\s+(\d{4}))?$/;
const seasonPattern =
  /^(?:(last\s+)|this\s+(?:past\s+)?)?(spring|summer|fall|autumn|winter)(?:,?\s+(?:of\s+)?(\d{4}))?$/;
const sincePattern = /^since\s+(.+)$/;
const weekdayPattern = /^(?:last\s+)?([a-z]+)$/;

const monthNumbers: Record<string, number> = {
  apr: 4,
  april: 4,
  aug: 8,
  august: 8,
  dec: 12,
  december: 12,
  feb: 2,
  february: 2,
  jan: 1,
  january: 1,
  jul: 7,
  july: 7,
  jun: 6,
  june: 6,
  mar: 3,
  march: 3,
  may: 5,
  nov: 11,
  november: 11,
  oct: 10,
  october: 10,
  sep: 9,
  sept: 9,
  september: 9,
};

const seasonStartMonths: Record<Season, number> = {
  autumn: 9,
  fall: 9,
  spring: 3,
  summer: 6,
  winter: 12,
};

// Monday is 0.
const weekdayNumbers: Record<string, number> = {
  fri: 4,
  friday: 4,
  mon: 0,
  monday: 0,
  sat: 5,
  saturday: 5,
  sun: 6,
  sunday: 6,
  thu: 3,
  thur: 3,
  thurs: 3,
  thursday: 3,
  tue: 1,
  tues: 1,
  tuesday: 1,
  wed: 2,
  wednesday: 2,
};

const countWords: Record<string, number> = {
  a: 1,
  an: 1,
  eight: 8,
  eleven: 11,
  few: 3,
  five: 5,
  four: 4,
  nine: 9,
  one: 1,
  seven: 7,
  six: 6,
  ten: 10,
  three: 3,
  twelve: 12,
  two: 2,
};

// A plain lookup would find "constructor" on Object.prototype.
function lookup(
  table: Record<string, number>,
  key: string | undefined
): number | undefined {
  return key !== undefined && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

function dayNumber(year: number, month: number, date: number): number {
  return Math.floor(Date.UTC(year, month - 1, date) / msPerDay);
}

function dayString(day: number): string {
  return new Date(day * msPerDay).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(day: number): { date: number; month: number; year: number } {
  const value = new Date(day * msPerDay);
  return {
    date: value.getUTCDate(),
    month: value.getUTCMonth() + 1,
    year: value.getUTCFullYear(),
  };
}

// Monday is 0. Day 0 was a Thursday.
function weekday(day: number): number {
  return (((day + 3) % daysPerWeek) + daysPerWeek) % daysPerWeek;
}

function weekStart(day: number): number {
  return day - weekday(day);
}

function addMonths(day: number, months: number): number {
  const { date, month, year } = parts(day);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  return dayNumber(
    targetYear,
    targetMonth,
    Math.min(date, daysInMonth(targetYear, targetMonth))
  );
}

function monthSpan(year: number, month: number): Span {
  return {
    from: dayNumber(year, month, 1),
    to: dayNumber(year, month + 1, 1) - 1,
  };
}

function yearSpan(year: number): Span {
  return { from: dayNumber(year, 1, 1), to: dayNumber(year + 1, 1, 1) - 1 };
}

function singleDay(day: number): Span {
  return { from: day, to: day };
}

function isRealDate(year: number, month: number, date: number): boolean {
  return (
    year >= oldestYear &&
    month >= 1 &&
    month <= monthsPerYear &&
    date >= 1 &&
    date <= daysInMonth(year, month)
  );
}

function parseDay(text: string): number | null {
  const match = isoDatePattern.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  return isRealDate(year, month, date) ? dayNumber(year, month, date) : null;
}

function parseCount(token: string | undefined): number | null {
  if (token === undefined) {
    return 1;
  }
  const count = digitsPattern.test(token)
    ? Number(token)
    : lookup(countWords, token);
  if (count === undefined || count < 1 || count > largestCount) {
    return null;
  }
  return count;
}

// "the last week" is the 7 days up to now, like "past week". Without "the",
// "last week" is the calendar week before this one.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(leadingQuotesPattern, "")
    .replace(trailingPunctuationPattern, "")
    .replace(whitespacePattern, " ")
    .replace(leadingWordsPattern, "")
    .replace(theLastPattern, "past ")
    .replace(leadingArticlePattern, "")
    .replace(couplePattern, "2");
}

// The days of a span that have come, or null when none has.
function untilToday(span: Span, today: number): Span | null {
  return span.from > today
    ? null
    : { from: span.from, to: Math.min(span.to, today) };
}

// Saturday and Sunday of the week that starts on `monday`.
function weekendOf(monday: number): Span {
  return { from: monday + 5, to: monday + 6 };
}

function namedSpan(phrase: string, today: number): Span | null {
  const { month, year } = parts(today);
  const lastMonth = monthSpan(year, month - 1);
  switch (phrase) {
    case "today":
      return singleDay(today);
    case "yesterday":
      return singleDay(today - 1);
    case "recently":
    case "lately":
    case "these days":
      return { from: today - (recentDays - 1), to: today };
    case "this week":
      return { from: weekStart(today), to: today };
    case "last week":
      return { from: weekStart(today) - daysPerWeek, to: weekStart(today) - 1 };
    case "last weekend":
      return weekendOf(weekStart(today) - daysPerWeek);
    case "this weekend":
      return untilToday(weekendOf(weekStart(today)), today);
    case "this past weekend":
    case "past weekend":
      return (
        untilToday(weekendOf(weekStart(today)), today) ??
        weekendOf(weekStart(today) - daysPerWeek)
      );
    case "this month":
      return { from: dayNumber(year, month, 1), to: today };
    case "last month":
      return lastMonth;
    case "this year":
      return { from: dayNumber(year, 1, 1), to: today };
    case "last year":
      return yearSpan(year - 1);
    default:
      return null;
  }
}

function rollingSpan(unit: Unit, count: number, today: number): Span {
  switch (unit) {
    case "day":
      return { from: today - (count - 1), to: today };
    case "week":
      return { from: today - (count * daysPerWeek - 1), to: today };
    case "month":
      return { from: addMonths(today, -count) + 1, to: today };
    default:
      return {
        from: addMonths(today, -count * monthsPerYear) + 1,
        to: today,
      };
  }
}

function rollingMatch(
  match: RegExpExecArray | null,
  countToken: string | undefined,
  today: number
): Span | null {
  if (match === null) {
    return null;
  }
  const count = parseCount(countToken);
  if (count === null) {
    return null;
  }
  return rollingSpan(match[2] as Unit, count, today);
}

function pastSpan(phrase: string, today: number): Span | null {
  const match = pastPattern.exec(phrase);
  return rollingMatch(match, match?.[1], today);
}

function lastCountSpan(phrase: string, today: number): Span | null {
  const match = lastCountPattern.exec(phrase);
  return rollingMatch(match, match?.[1], today);
}

function agoSpan(phrase: string, today: number): Span | null {
  const match = agoPattern.exec(phrase);
  if (match === null) {
    return null;
  }
  const count = parseCount(match[1]);
  if (count === null) {
    return null;
  }
  switch (match[2] as Unit) {
    case "day":
      return singleDay(today - count);
    case "week": {
      const start = weekStart(today - count * daysPerWeek);
      return { from: start, to: start + daysPerWeek - 1 };
    }
    case "month": {
      const { month, year } = parts(addMonths(today, -count));
      return monthSpan(year, month);
    }
    default:
      return yearSpan(parts(today).year - count);
  }
}

// "march" is the latest March that has started, and "last march" is the
// latest one that is over. A year in the phrase wins over both.
function monthNameSpan(phrase: string, today: number): Span | null {
  const match = monthPattern.exec(phrase);
  const month = lookup(monthNumbers, match?.[2]);
  if (match === null || month === undefined) {
    return null;
  }
  if (match[3] !== undefined) {
    const year = Number(match[3]);
    return year < oldestYear ? null : monthSpan(year, month);
  }
  const now = parts(today);
  const strict = match[1] !== undefined;
  const behind = strict ? month >= now.month : month > now.month;
  return monthSpan(behind ? now.year - 1 : now.year, month);
}

// "march 3" is the latest March 3 that has come, and a year in the phrase
// wins.
function datedSpan(
  monthToken: string | undefined,
  dayToken: string | undefined,
  yearToken: string | undefined,
  today: number
): Span | null {
  const month = lookup(monthNumbers, monthToken);
  if (month === undefined) {
    return null;
  }
  const date = Number(dayToken);
  if (yearToken !== undefined) {
    const year = Number(yearToken);
    return isRealDate(year, month, date)
      ? singleDay(dayNumber(year, month, date))
      : null;
  }
  const thisYear = parts(today).year;
  for (let year = thisYear; year > thisYear - leapDaySearchYears; year -= 1) {
    if (
      isRealDate(year, month, date) &&
      dayNumber(year, month, date) <= today
    ) {
      return singleDay(dayNumber(year, month, date));
    }
  }
  return null;
}

function monthDaySpan(phrase: string, today: number): Span | null {
  const match = monthDayPattern.exec(phrase);
  return match === null ? null : datedSpan(match[1], match[2], match[3], today);
}

function dayMonthSpan(phrase: string, today: number): Span | null {
  const match = dayMonthPattern.exec(phrase);
  return match === null ? null : datedSpan(match[2], match[1], match[3], today);
}

// Winter runs from December into the next year and belongs to the year it
// ends in, so "winter 2026" is December 2025 to February 2026.
function seasonYearSpan(season: Season, year: number): Span {
  const startMonth = seasonStartMonths[season];
  const startYear = season === "winter" ? year - 1 : year;
  return {
    from: dayNumber(startYear, startMonth, 1),
    to: dayNumber(startYear, startMonth + 3, 1) - 1,
  };
}

function seasonSpan(phrase: string, today: number): Span | null {
  const match = seasonPattern.exec(phrase);
  if (match === null) {
    return null;
  }
  const season = match[2] as Season;
  if (match[3] !== undefined) {
    const year = Number(match[3]);
    return year < oldestYear ? null : seasonYearSpan(season, year);
  }
  const strict = match[1] !== undefined;
  const thisYear = parts(today).year;
  for (let year = thisYear + 1; year >= thisYear - 1; year -= 1) {
    const span = seasonYearSpan(season, year);
    if (strict ? span.to < today : span.from <= today) {
      return span;
    }
  }
  return null;
}

// A weekday means the latest one before today, never today itself.
function weekdaySpan(phrase: string, today: number): Span | null {
  const target = lookup(weekdayNumbers, weekdayPattern.exec(phrase)?.[1]);
  if (target === undefined) {
    return null;
  }
  const back = (weekday(today) - target + daysPerWeek) % daysPerWeek;
  return singleDay(today - (back === 0 ? daysPerWeek : back));
}

function isoSpan(text: string): Span | null {
  const match = isoPartsPattern.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  if (year < oldestYear) {
    return null;
  }
  if (match[2] === undefined) {
    return yearSpan(year);
  }
  const month = Number(match[2]);
  if (month < 1 || month > monthsPerYear) {
    return null;
  }
  if (match[3] === undefined) {
    return monthSpan(year, month);
  }
  const date = Number(match[3]);
  return isRealDate(year, month, date)
    ? singleDay(dayNumber(year, month, date))
    : null;
}

function isoRangeSpan(phrase: string): Span | null {
  const sides = phrase.split(rangeSeparatorPattern);
  if (sides.length === 1) {
    return isoSpan(phrase);
  }
  if (sides.length !== 2) {
    return null;
  }
  const first = isoSpan(sides[0] ?? "");
  const second = isoSpan(sides[1] ?? "");
  if (first === null || second === null) {
    return null;
  }
  return { from: first.from, to: second.to };
}

const phraseMatchers: Matcher[] = [
  namedSpan,
  pastSpan,
  lastCountSpan,
  agoSpan,
  seasonSpan,
  monthNameSpan,
  monthDaySpan,
  dayMonthSpan,
  weekdaySpan,
  (phrase) => isoRangeSpan(phrase),
];

function firstSpan(
  phrase: string,
  today: number,
  candidates: Matcher[]
): Span | null {
  for (const matcher of candidates) {
    const span = matcher(phrase, today);
    if (span !== null) {
      return span;
    }
  }
  return null;
}

// "since March" runs from the start of March to today.
function sinceSpan(phrase: string, today: number): Span | null {
  const rest = sincePattern.exec(phrase)?.[1];
  if (rest === undefined) {
    return null;
  }
  const start = firstSpan(rest, today, phraseMatchers);
  return start === null
    ? null
    : untilToday({ from: start.from, to: today }, today);
}

const matchers: Matcher[] = [...phraseMatchers, sinceSpan];

// `today` is YYYY-MM-DD. The tool always reports the range it used, so a
// phrase read the wrong way is easy to spot and correct.
export function resolveWhen(text: string, today: string): WhenResult {
  const label = text.trim();
  const todayDay = parseDay(today);
  if (todayDay === null) {
    return { error: `Today's date "${today}" is not YYYY-MM-DD.` };
  }
  // Checked on the label, because reading it would drop the trailing dots.
  if (openRangePattern.test(label)) {
    return {
      error: `"${label}" is missing the date after "..". Pass when as YYYY-MM-DD..YYYY-MM-DD.`,
    };
  }
  const span = firstSpan(normalize(label), todayDay, matchers);
  if (span === null) {
    return {
      error: `Couldn't read "${label}" as a date. Pass when as YYYY-MM-DD..YYYY-MM-DD.`,
    };
  }
  if (span.from > span.to) {
    return {
      error: `"${label}" starts after it ends. Put the earlier date first.`,
    };
  }
  return {
    range: { from: dayString(span.from), label, to: dayString(span.to) },
  };
}

// The span for what the user said, or null when they named no time. Words
// that can't be read throw, so the tool call fails with the reason.
export function rangeFromWhen(text: string, today: string): DateRange | null {
  if (text.trim().length === 0) {
    return null;
  }
  const resolved = resolveWhen(text, today);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  return resolved.range;
}

function localDayString(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${date}`;
}

function localMidnight(day: string, laterDays: number): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + laterDays);
}

// The instants that bound a span of days on this Mac's clock: midnight at the
// start of `from`, and midnight after `to`, as ISO UTC times. Chat messages
// carry a time, not a day, so a chat search sends these instead of the days.
// A day that starts or ends daylight saving time keeps its local midnights.
export function instantsFromRange(range: { from: string; to: string }): {
  from: string;
  to: string;
} {
  return {
    from: localMidnight(range.from, 0).toISOString(),
    to: localMidnight(range.to, 1).toISOString(),
  };
}

// The day on this Mac's clock that an ISO time falls on, or null when the
// text is not a time.
export function localDayOf(instant: string): string | null {
  const time = Date.parse(instant);
  return Number.isNaN(time) ? null : localDayString(new Date(time));
}

// Today's date on this Mac. `SAGE_TODAY` (YYYY-MM-DD) pins it so evals run
// against a fixed day. Packaged Chat never sets it.
export function todayFromEnv(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): string {
  const pinned = env.SAGE_TODAY?.trim();
  if (pinned !== undefined && parseDay(pinned) !== null) {
    return pinned;
  }
  return localDayString(now);
}

export function describeToday(today: string): string {
  const day = parseDay(today);
  if (day === null) {
    return "";
  }
  const text = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
  }).format(new Date(day * msPerDay));
  return `Today is ${text}.`;
}
