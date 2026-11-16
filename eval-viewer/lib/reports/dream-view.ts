import type {
  DreamSource,
  DreamWritten,
  ReportItem,
  SetupReport,
  UnsupportedClaim,
} from "./sweep-types.ts";

/** One entry or chat that Dream was graded on, with its counts. */
export interface DreamSourceRow {
  item: ReportItem;
  /** The judge could not grade it: the claims are not a verdict. */
  notGraded: boolean;
  other: number;
  severe: number;
  source: DreamSource;
}

export interface DreamPersonGroup {
  graded: number;
  other: number;
  person: string;
  severe: number;
  sources: DreamSourceRow[];
  /** Sources with at least one claim. */
  withClaims: number;
}

function isSevere(claim: UnsupportedClaim): boolean {
  return claim.severity === "severe";
}

export function dreamSourceRow(item: ReportItem): DreamSourceRow | undefined {
  if (item.dream === undefined) {
    return;
  }
  const severe = item.dream.unsupportedClaims.filter(isSevere).length;
  return {
    item,
    notGraded: item.status === "not-graded",
    other: item.dream.unsupportedClaims.length - severe,
    severe,
    source: item.dream,
  };
}

/** Dream sources by person, in the report's order. Items without a Dream record are left out. */
export function dreamGroups(report: SetupReport): DreamPersonGroup[] {
  const groups = new Map<string, DreamPersonGroup>();
  for (const item of report.items) {
    const row = dreamSourceRow(item);
    if (row === undefined) {
      continue;
    }
    const group = groups.get(item.person) ?? {
      graded: 0,
      other: 0,
      person: item.person,
      severe: 0,
      sources: [],
      withClaims: 0,
    };
    group.sources.push(row);
    if (!row.notGraded) {
      group.graded += 1;
    }
    group.severe += row.severe;
    group.other += row.other;
    if (row.severe + row.other > 0) {
      group.withClaims += 1;
    }
    groups.set(item.person, group);
  }
  return [...groups.values()];
}

/** The groups for one person, or all of them. */
export function filterDreamGroups(
  groups: readonly DreamPersonGroup[],
  person: string | undefined,
  claimsOnly: boolean
): DreamPersonGroup[] {
  return groups
    .filter((group) => person === undefined || group.person === person)
    .map((group) =>
      claimsOnly
        ? {
            ...group,
            sources: group.sources.filter((row) => row.severe + row.other > 0),
          }
        : group
    );
}

function squash(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** What Dream wrote, with the claims that are about it and the position of each claim in the source's list. */
export interface WrittenWithClaims {
  claims: { claim: UnsupportedClaim; number: number }[];
  written: DreamWritten;
}

export interface DreamWrittenView {
  items: WrittenWithClaims[];
  /** Claims that match no item Dream wrote. The judge can name text Dream never wrote. */
  strays: { claim: UnsupportedClaim; number: number }[];
}

/**
 * Matches each claim to the item Dream wrote. A claim names its item's text.
 * When that text is not among the written items, the claim goes to the first
 * item that holds its quote. A claim that fits neither is a stray. Claims are
 * numbered from 1 in the order the judge gave them.
 */
export function writtenWithClaims(source: DreamSource): DreamWrittenView {
  const texts = source.written.map((written) => squash(written.text));
  const items: WrittenWithClaims[] = source.written.map((written) => ({
    claims: [],
    written,
  }));
  const strays: DreamWrittenView["strays"] = [];
  source.unsupportedClaims.forEach((claim, index) => {
    const entry = { claim, number: index + 1 };
    const named = squash(claim.itemText);
    let position = texts.indexOf(named);
    if (position === -1 && claim.quote.length > 0) {
      const quote = squash(claim.quote);
      position = texts.findIndex((text) => text.includes(quote));
    }
    const target = position === -1 ? undefined : items[position];
    if (target === undefined) {
      strays.push(entry);
    } else {
      target.claims.push(entry);
    }
  });
  return { items, strays };
}

export interface Segment {
  /** The claim number, from 1, when the segment is a quoted claim. */
  claim?: number;
  /** Where the segment starts in the text. */
  start: number;
  text: string;
}

interface Range {
  claim: number;
  end: number;
  start: number;
}

function findQuote(text: string, quote: string): number {
  const exact = text.indexOf(quote);
  if (exact !== -1) {
    return exact;
  }
  return text.toLowerCase().indexOf(quote.toLowerCase());
}

/**
 * Cuts text into plain and quoted parts, one quoted part for each claim whose
 * quote is in it. A quote that is not there, or that overlaps an earlier one,
 * is left out and listed in `unplaced`, so the caller can show its reason on
 * its own.
 */
export function highlightClaims(
  text: string,
  claims: readonly { number: number; quote: string }[]
): { segments: Segment[]; unplaced: number[] } {
  const ranges: Range[] = [];
  const unplaced: number[] = [];
  for (const { number, quote } of claims) {
    const start = quote.length === 0 ? -1 : findQuote(text, quote);
    if (start === -1) {
      unplaced.push(number);
      continue;
    }
    ranges.push({ claim: number, end: start + quote.length, start });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Range[] = [];
  for (const range of ranges) {
    const last = kept.at(-1);
    if (last !== undefined && range.start < last.end) {
      unplaced.push(range.claim);
    } else {
      kept.push(range);
    }
  }
  const segments: Segment[] = [];
  let at = 0;
  for (const range of kept) {
    if (range.start > at) {
      segments.push({ start: at, text: text.slice(at, range.start) });
    }
    segments.push({
      claim: range.claim,
      start: range.start,
      text: text.slice(range.start, range.end),
    });
    at = range.end;
  }
  if (at < text.length) {
    segments.push({ start: at, text: text.slice(at) });
  }
  return { segments, unplaced: unplaced.sort((a, b) => a - b) };
}

/** Words for a Dream item kind, as the judge names them. */
export const dreamItemKindLabel: Record<string, string> = {
  "chat-summary": "Chat summary",
  "chat-title": "Chat title",
  event: "Event",
  fact: "Fact",
  profile: "Profile",
  summary: "Summary",
};

export function dreamKindLabel(kind: string): string {
  return Object.hasOwn(dreamItemKindLabel, kind)
    ? (dreamItemKindLabel[kind] ?? kind)
    : kind;
}
