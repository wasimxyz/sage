import { differenceInCalendarDays } from "date-fns/differenceInCalendarDays";
import { differenceInCalendarMonths } from "date-fns/differenceInCalendarMonths";
import { differenceInCalendarYears } from "date-fns/differenceInCalendarYears";
import { differenceInDays } from "date-fns/differenceInDays";
import { differenceInHours } from "date-fns/differenceInHours";
import { differenceInMinutes } from "date-fns/differenceInMinutes";
import { differenceInMonths } from "date-fns/differenceInMonths";
import { differenceInYears } from "date-fns/differenceInYears";
import { intlFormat } from "date-fns/intlFormat";
import { intlFormatDistance } from "date-fns/intlFormatDistance";
import { isValid } from "date-fns/isValid";
import { parse } from "date-fns/parse";
import { parseISO } from "date-fns/parseISO";

const calendarDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const missingUpdatedAt = Date.parse("1970-01-01T00:00:00.000Z");

type DistanceUnit = "day" | "hour" | "minute" | "month" | "week" | "year";

function parseInstant(iso: string): Date | null {
  const date = parseISO(iso);
  return isValid(date) ? date : null;
}

function parseCalendarDay(value: string): Date | null {
  const date = parse(value.trim().slice(0, 10), "yyyy-MM-dd", new Date());
  return isValid(date) ? date : null;
}

function formatCompactDays(
  days: number,
  months: number,
  years: number
): string {
  if (days < 7) {
    return `${days}d`;
  }
  if (days < 30) {
    return `${Math.max(1, Math.floor(days / 7))}w`;
  }
  if (months < 12) {
    return `${Math.max(1, months)}mo`;
  }
  return `${Math.max(1, years)}y`;
}

export function formatRelativeAge(iso: string, now = Date.now()): string {
  const trimmed = iso.trim();
  if (calendarDayPattern.test(trimmed)) {
    return formatRelativeCalendarAge(trimmed, now);
  }
  const then = parseInstant(trimmed);
  if (!then) {
    return "";
  }
  const end = new Date(now);
  const minutes = Math.max(0, differenceInMinutes(end, then));
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = Math.max(0, differenceInHours(end, then));
  if (hours < 24) {
    return `${hours}h`;
  }
  return formatCompactDays(
    Math.max(0, differenceInDays(end, then)),
    Math.max(0, differenceInMonths(end, then)),
    Math.max(0, differenceInYears(end, then))
  );
}

export function formatRelativeCalendarAge(
  value: string,
  now = Date.now()
): string {
  const date = parseCalendarDay(value);
  if (!date) {
    return "";
  }
  const end = new Date(now);
  const days = differenceInCalendarDays(end, date);
  if (days < 0) {
    return "";
  }
  if (days === 0) {
    return "Today";
  }
  return formatCompactDays(
    days,
    Math.max(0, differenceInCalendarMonths(end, date)),
    Math.max(0, differenceInCalendarYears(end, date))
  );
}

export function formatLastDreamed(iso: string, now = Date.now()): string {
  const then = parseInstant(iso);
  if (!then) {
    return "";
  }
  const end = new Date(now);
  const minutes = Math.max(0, differenceInMinutes(end, then));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.max(0, differenceInHours(end, then));
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.max(0, differenceInDays(end, then));
  if (days === 1) {
    return "yesterday";
  }
  return `${days} days ago`;
}

function formatDistanceAgo(then: Date, now: Date, unit: DistanceUnit): string {
  return intlFormatDistance(then, now, {
    locale: "en",
    numeric: "always",
    unit,
  });
}

function lastEditedAge(iso: string, now: number): string {
  const then = parseInstant(iso);
  if (!then || then.getTime() === missingUpdatedAt) {
    return "";
  }
  const end = new Date(now);
  const minutes = Math.max(0, differenceInMinutes(end, then));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return formatDistanceAgo(then, end, "minute");
  }
  const hours = Math.max(0, differenceInHours(end, then));
  if (hours < 24) {
    return formatDistanceAgo(then, end, "hour");
  }
  const days = Math.max(0, differenceInDays(end, then));
  if (days < 7) {
    return formatDistanceAgo(then, end, "day");
  }
  if (days < 30) {
    return formatDistanceAgo(then, end, "week");
  }
  const months = Math.max(0, differenceInMonths(end, then));
  if (months < 12) {
    return formatDistanceAgo(then, end, "month");
  }
  return formatDistanceAgo(then, end, "year");
}

export function formatLastEdited(iso: string, now = Date.now()): string {
  const age = lastEditedAge(iso, now);
  if (age.length === 0) {
    return "";
  }
  return `Last edited ${age}`;
}

export function formatMemoryUpdated(iso: string, now = Date.now()): string {
  const relative = formatLastDreamed(iso, now);
  if (relative.length === 0) {
    return "";
  }
  return `Updated ${relative}`;
}

export function formatMemoryUpdatedOn(iso: string): string {
  const date = parseInstant(iso);
  if (!date) {
    return "";
  }
  return `Updated ${intlFormat(date, {
    day: "numeric",
    month: "short",
  })}`;
}

export function formatMemoryDate(iso: string): string {
  const date = parseInstant(iso);
  if (!date) {
    return "";
  }
  return intlFormat(date, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
