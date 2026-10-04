import { secondsInMonth } from "date-fns/constants";
import { differenceInCalendarDays } from "date-fns/differenceInCalendarDays";
import { differenceInCalendarMonths } from "date-fns/differenceInCalendarMonths";
import { differenceInCalendarWeeks } from "date-fns/differenceInCalendarWeeks";
import { differenceInSeconds } from "date-fns/differenceInSeconds";
import { format } from "date-fns/format";
import { intlFormat } from "date-fns/intlFormat";
import { intlFormatDistance } from "date-fns/intlFormatDistance";
import { isSameYear } from "date-fns/isSameYear";
import { isValid } from "date-fns/isValid";
import { parse } from "date-fns/parse";
import { startOfMonth } from "date-fns/startOfMonth";
import { startOfWeek } from "date-fns/startOfWeek";
import { startOfYear } from "date-fns/startOfYear";

const sunday = { weekStartsOn: 0 as const };

type EventAgeUnit = "month" | "week" | "year";

export function parseCalendarDate(value: string): Date | null {
  const date = parse(value.trim().slice(0, 10), "yyyy-MM-dd", new Date());
  return isValid(date) ? date : null;
}

export function calendarDateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function eventAgeUnit(date: Date, now: Date): EventAgeUnit {
  if (Math.abs(differenceInSeconds(date, now)) < secondsInMonth) {
    return "week";
  }
  if (Math.abs(differenceInCalendarMonths(date, now)) < 12) {
    return "month";
  }
  return "year";
}

function eventAgeStart(date: Date, unit: EventAgeUnit): Date {
  if (unit === "week") {
    return startOfWeek(date, sunday);
  }
  if (unit === "month") {
    return startOfMonth(date);
  }
  return startOfYear(date);
}

function formatEventAgeTitle(
  start: Date,
  now: Date,
  unit: EventAgeUnit
): string {
  if (unit === "week" && differenceInCalendarWeeks(now, start, sunday) === 0) {
    return "This week";
  }
  const label = intlFormatDistance(start, now, {
    locale: "en",
    numeric: "always",
    unit,
  });
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

export function eventAgeGroup(
  value: string,
  now = new Date()
): { key: string; title: string } | null {
  const date = parseCalendarDate(value);
  if (!date) {
    return null;
  }
  const unit = eventAgeUnit(date, now);
  const start = eventAgeStart(date, unit);
  return {
    key: format(start, "yyyy-MM-dd"),
    title: formatEventAgeTitle(start, now, unit),
  };
}

export function formatEventAge(value: string, now = new Date()): string {
  return eventAgeGroup(value, now)?.title ?? value;
}

export function formatEntryDate(value: string): string {
  const date = parseCalendarDate(value);
  if (!date) {
    return value;
  }
  return intlFormat(date, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatHomeHeadingDate(now = new Date()): string {
  return intlFormat(
    now,
    {
      day: "numeric",
      month: "long",
      weekday: "long",
    },
    { locale: "en" }
  );
}

export function formatJournalListDate(value: string, now = new Date()): string {
  const date = parseCalendarDate(value);
  if (!date) {
    return value;
  }
  const diffDays = differenceInCalendarDays(now, date);
  if (diffDays < 0) {
    return formatEntryDate(value);
  }
  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 14) {
    return "1 week ago";
  }
  if (isSameYear(date, now)) {
    return intlFormat(date, {
      day: "numeric",
      month: "short",
    });
  }
  return intlFormat(date, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
