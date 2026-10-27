import { formatShortEntryDate, parseCalendarDate } from "../format-date.ts";

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;

export interface JournalToolSearchHit {
  date: string;
  id: number;
  title: string;
}

export interface JournalToolEntry {
  date: string;
  id: number;
  title: string;
}

export interface JournalSearchRange {
  from: string;
  to: string;
}

/**
 * The first row of a search card. `query` is the words searched for, which the
 * row sets apart. The rest is plain text, so the dates read like the words
 * around them: `lead` comes before the query and `rest` after it.
 */
export interface JournalSearchSummary {
  lead: string;
  query: string | null;
  rest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCalendarDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    calendarDate.test(value) &&
    parseCalendarDate(value) !== null
  );
}

/** What the user searched for, or null when the search had no words. */
export function journalSearchQuery(input: unknown): string | null {
  if (!isRecord(input) || typeof input.query !== "string") {
    return null;
  }
  const query = input.query.trim();
  return query.length > 0 ? query : null;
}

/**
 * The entries a search found. A search by meaning comes back as a list. A
 * search with dates, or one that has a note for the model, comes back as an
 * object with the list under `entries`.
 */
export function journalSearchHits(
  output: unknown
): JournalToolSearchHit[] | null {
  const list = isRecord(output) ? output.entries : output;
  if (!Array.isArray(list)) {
    return null;
  }

  const hits: JournalToolSearchHit[] = [];
  for (const item of list) {
    if (
      !(
        isRecord(item) &&
        isPositiveInteger(item.id) &&
        typeof item.title === "string" &&
        typeof item.date === "string"
      )
    ) {
      return null;
    }
    hits.push({ date: item.date, id: item.id, title: item.title });
  }
  return hits;
}

/** The days a dated search covered, or null when it had no dates. */
export function journalSearchRange(output: unknown): JournalSearchRange | null {
  if (!(isRecord(output) && isRecord(output.range))) {
    return null;
  }
  const { from, to } = output.range;
  return isCalendarDate(from) && isCalendarDate(to) ? { from, to } : null;
}

function rangeText(range: JournalSearchRange, now: Date): string {
  const from = formatShortEntryDate(range.from, now);
  if (range.from === range.to) {
    return `on ${from}`;
  }
  return `from ${from} to ${formatShortEntryDate(range.to, now)}`;
}

/**
 * What the first row of a search card says: the words searched for and the
 * days covered. Null when the search had neither.
 */
export function journalSearchSummary(
  query: string | null,
  range: JournalSearchRange | null,
  now = new Date()
): JournalSearchSummary | null {
  if (query !== null) {
    return {
      lead: "Searched for ",
      query: `“${query}”`,
      rest: range === null ? "" : ` ${rangeText(range, now)}`,
    };
  }
  if (range === null) {
    return null;
  }
  return { lead: `Entries ${rangeText(range, now)}`, query: null, rest: "" };
}

export function journalEntryOutput(output: unknown): JournalToolEntry | null {
  if (
    !(
      isRecord(output) &&
      isPositiveInteger(output.id) &&
      typeof output.title === "string" &&
      typeof output.date === "string"
    )
  ) {
    return null;
  }
  return { date: output.date, id: output.id, title: output.title };
}
