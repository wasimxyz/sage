import { format } from "date-fns/format";
import { getDaysInMonth } from "date-fns/getDaysInMonth";
import { intlFormat } from "date-fns/intlFormat";
import { startOfWeek } from "date-fns/startOfWeek";
import { subDays } from "date-fns/subDays";

import type { ChatConversationMeta, JournalEntryMeta } from "../bridge.ts";
import {
  calendarDateKey,
  localDateKey,
  parseCalendarDate,
} from "./format-date.ts";

export type HomeEntry = Pick<
  JournalEntryMeta,
  "date" | "id" | "title" | "updatedAt"
>;
export type HomeChat = Pick<ChatConversationMeta, "id" | "title" | "updatedAt">;

export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type HomeGroup = "lastWeek" | "thisWeek" | "today";

export interface HomeRow {
  /** The local calendar day the row belongs to, as `yyyy-MM-dd`. */
  day: string;
  id: number;
  kind: "chat" | "entry";
  title: string;
  updatedAt: string;
}

export type HomeGroups = Record<HomeGroup, HomeRow[]>;

export interface MonthDay {
  date: string;
  day: number;
  entryId: number | null;
  label: string;
  state: "empty" | "future" | "written";
  today: boolean;
}

const morningStartsAt = 5;
const afternoonStartsAt = 12;
const eveningStartsAt = 17;
const greetingHours = [morningStartsAt, afternoonStartsAt, eveningStartsAt];

const endsInPunctuation = /[.!?…]$/;

export function greetingFor(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= eveningStartsAt || hour < morningStartsAt) {
    return "Good evening.";
  }
  return hour < afternoonStartsAt ? "Good morning." : "Good afternoon.";
}

/** The next moment the greeting turns over: 5 AM, noon, or 5 PM. */
export function nextGreetingChange(now = new Date()): Date {
  for (const hour of greetingHours) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
    if (at.getTime() > now.getTime()) {
      return at;
    }
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    morningStartsAt
  );
}

/** The next moment Home's labels can turn over: a new greeting or a new day. */
export function nextHomeChange(now = new Date()): Date {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  const greeting = nextGreetingChange(now);
  return greeting.getTime() < midnight.getTime() ? greeting : midnight;
}

/** The month's name, such as "October". */
export function monthName(now = new Date()): string {
  return format(now, "MMMM");
}

export function entryTitle(title: string): string {
  return title.trim() || "Untitled";
}

export function chatTitle(title: string): string {
  return title.trim() || "Untitled chat";
}

/**
 * The entry from the same day of the month in the month before, or null. When
 * that day does not exist, as for March 31, there is none. With several
 * entries on the day, the newest one wins.
 */
export function monthAgoEntry(
  entries: readonly HomeEntry[],
  now = new Date()
): HomeEntry | null {
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (now.getDate() > getDaysInMonth(lastMonth)) {
    return null;
  }
  const date = calendarDateKey(
    new Date(lastMonth.getFullYear(), lastMonth.getMonth(), now.getDate())
  );
  let found: HomeEntry | null = null;
  for (const entry of entries) {
    if (entry.date === date && (found === null || entry.id > found.id)) {
      found = entry;
    }
  }
  return found;
}

/** Built from the saved title only. Nothing here asks a model. */
export function monthAgoLine(title: string): string {
  const text = entryTitle(title);
  const stop = endsInPunctuation.test(text) ? "" : ".";
  return `A month ago today, you wrote “${text}${stop}”`;
}

/** One item for each day of the month `now` is in. */
export function monthDays(
  entries: readonly HomeEntry[],
  now = new Date()
): MonthDay[] {
  const newest = new Map<string, number>();
  for (const entry of entries) {
    const known = newest.get(entry.date);
    if (known === undefined || entry.id > known) {
      newest.set(entry.date, entry.id);
    }
  }
  const todayKey = calendarDateKey(now);
  const days: MonthDay[] = [];
  for (let day = 1; day <= getDaysInMonth(now); day += 1) {
    const at = new Date(now.getFullYear(), now.getMonth(), day);
    const date = calendarDateKey(at);
    const entryId = newest.get(date) ?? null;
    const today = date === todayKey;
    let state: MonthDay["state"] = "empty";
    if (entryId !== null) {
      state = "written";
    } else if (date > todayKey) {
      state = "future";
    }
    const parts = [format(at, "MMMM d")];
    if (today) {
      parts.push("today");
    }
    if (state === "written") {
      parts.push("entry written");
    } else if (state === "empty") {
      parts.push("no entry");
    }
    days.push({ date, day, entryId, label: parts.join(", "), state, today });
  }
  return days;
}

/** Maps NSCalendar's `firstWeekday` (1 is Sunday) to date-fns (0 is Sunday). */
export function weekStartsOnFrom(firstWeekday: number): WeekDay {
  const days: readonly WeekDay[] = [0, 1, 2, 3, 4, 5, 6];
  return days[firstWeekday - 1] ?? 0;
}

function newerFirst(first: HomeRow, second: HomeRow): number {
  if (first.day !== second.day) {
    return first.day < second.day ? 1 : -1;
  }
  if (first.updatedAt !== second.updatedAt) {
    return first.updatedAt < second.updatedAt ? 1 : -1;
  }
  return second.id - first.id;
}

/**
 * Entries and chats together, newest first, under Today, This week, and Last
 * week. A week starts on `weekStartsOn`. Anything older, and anything dated
 * ahead, is left out.
 */
export function groupHomeItems(
  entries: readonly HomeEntry[],
  chats: readonly HomeChat[],
  now = new Date(),
  weekStartsOn: WeekDay = 0
): HomeGroups {
  const rows: HomeRow[] = [
    ...entries.map((entry) => ({
      day: entry.date,
      id: entry.id,
      kind: "entry" as const,
      title: entryTitle(entry.title),
      updatedAt: entry.updatedAt,
    })),
    ...chats.map((chat) => ({
      day: localDateKey(chat.updatedAt),
      id: chat.id,
      kind: "chat" as const,
      title: chatTitle(chat.title),
      updatedAt: chat.updatedAt,
    })),
  ];
  rows.sort(newerFirst);

  const today = calendarDateKey(now);
  const thisWeekStart = startOfWeek(now, { weekStartsOn });
  const thisWeek = calendarDateKey(thisWeekStart);
  const lastWeek = calendarDateKey(subDays(thisWeekStart, 7));
  const groups: HomeGroups = { lastWeek: [], thisWeek: [], today: [] };
  for (const row of rows) {
    if (row.day > today) {
      continue;
    }
    if (row.day === today) {
      groups.today.push(row);
    } else if (row.day >= thisWeek) {
      groups.thisWeek.push(row);
    } else if (row.day >= lastWeek) {
      groups.lastWeek.push(row);
    }
  }
  return groups;
}

function formatIntl(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  locale?: string
): string {
  return locale === undefined
    ? intlFormat(date, options)
    : intlFormat(date, options, { locale });
}

/**
 * The time for Today, the weekday for This week, and a short date such as
 * "Sat, Oct 17" for Last week. `locale` is for tests.
 */
export function homeRowDate(
  row: HomeRow,
  group: HomeGroup,
  locale?: string
): string {
  if (group === "today") {
    const at = new Date(row.updatedAt);
    return Number.isNaN(at.getTime())
      ? "Today"
      : formatIntl(at, { hour: "numeric", minute: "2-digit" }, locale);
  }
  const day = parseCalendarDate(row.day);
  if (!day) {
    return row.day;
  }
  if (group === "thisWeek") {
    return formatIntl(day, { weekday: "long" }, locale);
  }
  return formatIntl(
    day,
    { day: "numeric", month: "short", weekday: "short" },
    locale
  );
}
