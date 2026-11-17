import { checkLabel } from "./check-info.ts";
import {
  formatMegabytes,
  formatMs,
  formatRate,
  formatScore,
  formatSpread,
  formatUsd,
} from "./format.ts";
import { itemExpect, itemKey } from "./item-view.ts";
import type {
  DimensionKey,
  ReportItem,
  SetupDimensions,
  SetupReport,
} from "./sweep-types.ts";
import { dimensionKeys } from "./sweep-types.ts";
import { failedCheckCount, setupLabel } from "./sweep-view.ts";

type Params = Record<string, string | string[] | undefined>;

/** What the compare page reads from its address. */
export interface CompareQuery {
  a?: string;
  b?: string;
  expect?: string;
  /** Only items where either setup failed a check. */
  failing: boolean;
  kind?: string;
  person?: string;
}

function first(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text.length === 0 ? undefined : text;
}

export function parseCompareQuery(params: Params): CompareQuery {
  const failing = first(params.failing);
  return {
    a: first(params.a),
    b: first(params.b),
    expect: first(params.expect),
    failing: failing === "1" || failing === "true" || failing === "on",
    kind: first(params.kind),
    person: first(params.person),
  };
}

/** The part of the query the filters own, as the pairs a link or a form needs. */
export function filterParams(query: CompareQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.person !== undefined) {
    params.person = query.person;
  }
  if (query.kind !== undefined) {
    params.kind = query.kind;
  }
  if (query.expect !== undefined) {
    params.expect = query.expect;
  }
  if (query.failing) {
    params.failing = "1";
  }
  return params;
}

/** One item as both setups ran it. A side is missing when that setup has no such item. */
export interface ComparedItem {
  a?: ReportItem;
  b?: ReportItem;
  expect?: string;
  itemId: string;
  key: string;
  kind: string;
  person: string;
  repeat: number;
}

/** Pairs the items of two setups by item id and repeat, ordered by person, then id, then repeat. */
export function pairItems(a: SetupReport, b: SetupReport): ComparedItem[] {
  const byKey = new Map<string, ComparedItem>();
  for (const [side, report] of [
    ["a", a],
    ["b", b],
  ] as const) {
    for (const item of report.items) {
      const key = itemKey(item);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          [side]: item,
          expect: itemExpect(item),
          itemId: item.itemId,
          key,
          kind: item.kind,
          person: item.person,
          repeat: item.repeat,
        });
      } else {
        existing[side] = item;
        existing.expect ??= itemExpect(item);
      }
    }
  }
  return [...byKey.values()].sort(
    (x, y) =>
      x.person.localeCompare(y.person) ||
      x.itemId.localeCompare(y.itemId) ||
      x.repeat - y.repeat
  );
}

/** True when either setup failed a check on the item. */
export function failsOnEitherSide(item: ComparedItem): boolean {
  return (
    (item.a !== undefined && failedCheckCount(item.a) > 0) ||
    (item.b !== undefined && failedCheckCount(item.b) > 0)
  );
}

export function filterCompared(
  items: readonly ComparedItem[],
  query: CompareQuery
): ComparedItem[] {
  return items.filter(
    (item) =>
      (query.person === undefined || item.person === query.person) &&
      (query.kind === undefined || item.kind === query.kind) &&
      (query.expect === undefined || item.expect === query.expect) &&
      (!query.failing || failsOnEitherSide(item))
  );
}

export interface FilterOptions {
  expects: string[];
  kinds: string[];
  people: string[];
}

function sortedUnique(values: Iterable<string | undefined>): string[] {
  return [
    ...new Set(
      [...values].filter(
        (value): value is string => value !== undefined && value.length > 0
      )
    ),
  ].sort((x, y) => x.localeCompare(y));
}

/** The values each filter can take, from the items of both setups. */
export function filterOptions(items: readonly ComparedItem[]): FilterOptions {
  return {
    expects: sortedUnique(items.map((item) => item.expect)),
    kinds: sortedUnique(items.map((item) => item.kind)),
    people: sortedUnique(items.map((item) => item.person)),
  };
}

/** The dimensions on which two setups differ. */
export function differingDimensions(
  a: SetupDimensions,
  b: SetupDimensions
): DimensionKey[] {
  return dimensionKeys.filter((key) => a[key] !== b[key]);
}

/** A name for each setup that tells them apart, or the plain label when they differ in nothing shown. */
export function compareLabels(
  a: SetupReport,
  b: SetupReport
): { a: string; b: string } {
  const keys = differingDimensions(a.setup, b.setup);
  if (keys.length === 0) {
    return { a: setupLabel(a.setup), b: setupLabel(b.setup) };
  }
  return { a: setupLabel(a.setup, keys), b: setupLabel(b.setup, keys) };
}

function hardText(report: SetupReport): string {
  const failures = report.summary.hardFailures;
  return failures.length === 0
    ? "Passed"
    : `Failed: ${failures.map((failure) => checkLabel(failure.id)).join(", ")}`;
}

/** The two setups' summary numbers, one row for each, for the head of the page. */
export function summaryRows(
  a: SetupReport,
  b: SetupReport
): { a: string; b: string; label: string }[] {
  const rows: [string, (report: SetupReport) => string][] = [
    ["Hard checks", hardText],
    [
      "Counted failures",
      ({ summary }) =>
        `${summary.countedFailures} · ${formatRate(summary.countedRate)}`,
    ],
    ["Rubric mean", ({ summary }) => formatScore(summary.rubricMean)],
    ["Rubric spread", ({ summary }) => formatSpread(summary.rubricSpread)],
    [
      "First word, median",
      ({ summary }) => formatMs(summary.firstWordMedianMs),
    ],
    ["First word, p90", ({ summary }) => formatMs(summary.firstWordP90Ms)],
    ["Swap growth", ({ summary }) => formatMegabytes(summary.swapGrowthMB)],
    ["Cost", ({ summary }) => formatUsd(summary.costUsd)],
    [
      "Graded · not graded",
      ({ summary }) => `${summary.graded} · ${summary.notGraded}`,
    ],
  ];
  return rows.map(([label, read]) => ({ a: read(a), b: read(b), label }));
}

/** How many items each side lacks, for a note above the list. */
export function missingCounts(items: readonly ComparedItem[]): {
  a: number;
  b: number;
} {
  return {
    a: items.filter((item) => item.a === undefined).length,
    b: items.filter((item) => item.b === undefined).length,
  };
}
