import type { DateRange } from "./when";

interface Nearest {
  after: string | null;
  before: string | null;
}

// What Sage's journal search sends back. The counts come only with a date
// range, so a missing one reads as 0.
interface Reply {
  belowCutoff: number;
  entries: unknown[];
  matched: number;
  nearest: Nearest | null;
  total: number;
  unsummarized: number;
}

export interface RangeResult {
  entries: unknown[];
  nearest?: Nearest;
  note?: string;
  range: DateRange;
  today: string;
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return Reflect.get(value, key);
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readReply(payload: unknown): Reply {
  const entries = field(payload, "entries");
  const nearest = field(payload, "nearest");
  return {
    belowCutoff: whole(field(payload, "belowCutoff")),
    entries: Array.isArray(entries) ? entries : [],
    matched: whole(field(payload, "matched")),
    nearest:
      nearest === null || nearest === undefined
        ? null
        : {
            after: dateOrNull(field(nearest, "after")),
            before: dateOrNull(field(nearest, "before")),
          },
    total: whole(field(payload, "total")),
    unsummarized: whole(field(payload, "unsummarized")),
  };
}

// "3 entries", or "3 more entries" with an adjective.
function countEntries(count: number, adjective = ""): string {
  return count === 1 ? `1 ${adjective}entry` : `${count} ${adjective}entries`;
}

function emptyRangeNote(range: DateRange, nearest: Nearest | null): string {
  const when =
    range.from === range.to
      ? `on ${range.from}`
      : `from ${range.from} to ${range.to}`;
  const dates = [nearest?.before, nearest?.after].filter(
    (date): date is string => typeof date === "string"
  );
  const none = `No entries are dated ${when}.`;
  if (dates.length === 0) {
    return none;
  }
  const verb = dates.length === 1 ? "entry is" : "entries are";
  return `${none} The nearest ${verb} ${dates.join(" and ")}.`;
}

function searchNotes(reply: Reply, range: DateRange): string[] {
  if (reply.total === 0) {
    return [emptyRangeNote(range, reply.nearest)];
  }
  const notes: string[] = [];
  const shown = reply.entries.length;
  if (reply.belowCutoff > 0) {
    notes.push(
      shown > 0
        ? `${countEntries(reply.belowCutoff, "more ")} from this range didn't match. Leave out query to see them.`
        : `${countEntries(reply.belowCutoff)} in this range didn't match. Leave out query to see them.`
    );
  }
  if (reply.matched > shown) {
    notes.push(
      `Showing ${shown} of ${reply.matched} matches. Narrow when to see the rest.`
    );
  }
  if (reply.unsummarized > 0) {
    const one = reply.unsummarized === 1;
    notes.push(
      `${countEntries(reply.unsummarized)} in this range ${one ? "has" : "have"} no summary yet, so search by meaning can't see ${one ? "it" : "them"}. Dream in the sidebar adds ${one ? "it" : "them"}.`
    );
  }
  return notes;
}

function listNotes(reply: Reply, range: DateRange): string[] {
  if (reply.total === 0) {
    return [emptyRangeNote(range, reply.nearest)];
  }
  const shown = reply.entries.length;
  if (reply.total > shown) {
    return [
      `Showing ${shown} of ${reply.total} entries from across the range. Add a query or narrow when to see more.`,
    ];
  }
  return [];
}

// Wraps a ranged search so the model sees which dates were used, and gets a
// plain sentence for anything the entries alone do not say.
export function shapeRangeResult(input: {
  hasQuery: boolean;
  payload: unknown;
  range: DateRange;
  today: string;
}): RangeResult {
  const { hasQuery, payload, range, today } = input;
  const reply = readReply(payload);
  const notes = hasQuery ? searchNotes(reply, range) : listNotes(reply, range);
  return {
    entries: reply.entries,
    ...(reply.total === 0 && reply.nearest !== null
      ? { nearest: reply.nearest }
      : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    range,
    today,
  };
}
