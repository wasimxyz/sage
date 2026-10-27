// The dates in the seed files are a baseline. The entries name weekdays, so
// every date moves by the same whole number of weeks: the latest one lands on
// the last day on or before today with the same weekday. Gaps between entries
// stay the same, and no entry lands in the future.
//
// Dates are plain calendar days. Day numbers count days since 1970-01-01 and
// are built with Date.UTC, so no time zone can move a date by one day.

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const msPerDay = 86_400_000;
const daysPerWeek = 7;

export interface DatedEntry {
  date: string;
  fileName: string;
}

/** Moves every entry's date so the latest lands in the last 7 days. */
export function moveToToday<T extends DatedEntry>(
  entries: readonly T[],
  today: string
): { days: number; entries: T[] } {
  const todayDay = parseDay(today);
  if (todayDay === null) {
    throw new Error(`Today is not a YYYY-MM-DD date: ${today}`);
  }
  const days = entryDays(entries);
  if (days.length === 0) {
    throw new Error("There are no entries to date.");
  }
  const baseline = Math.max(...days);
  // How many days today is past the baseline's weekday, from 0 to 6.
  const pastWeekday =
    (((todayDay - baseline) % daysPerWeek) + daysPerWeek) % daysPerWeek;
  const offset = todayDay - pastWeekday - baseline;
  return {
    days: offset,
    entries: entries.map((entry, index) => ({
      ...entry,
      date: dayString((days[index] ?? 0) + offset),
    })),
  };
}

/** Today's date on this Mac, in its local time zone. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${date}`;
}

function entryDays(entries: readonly DatedEntry[]): number[] {
  return entries.map((entry) => {
    const day = parseDay(entry.date);
    if (day === null) {
      throw new Error(
        `${entry.fileName} has a date that is not on the calendar: ${entry.date}`
      );
    }
    return day;
  });
}

function parseDay(text: string): number | null {
  const match = isoDatePattern.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const day = Math.floor(Date.UTC(year, month - 1, date) / msPerDay);
  // Date.UTC rolls 2026-02-30 over to March, so read the day back.
  return dayString(day) === text ? day : null;
}

function dayString(day: number): string {
  return new Date(day * msPerDay).toISOString().slice(0, 10);
}
