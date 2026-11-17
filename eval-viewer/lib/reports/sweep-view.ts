import {
  type DimensionKey,
  dimensionKeys,
  type HardFailure,
  type ParseOutcome,
  type RankingEntry,
  type ReportItem,
  type SetupDimensions,
  type SetupReport,
  type SweepAxes,
  type SweepSummary,
} from "./sweep-types.ts";

export const dimensionLabel: Record<DimensionKey, string> = {
  chatModel: "Chat model",
  contextLength: "Context length",
  dreamPrompt: "Dream prompt",
  embedModel: "Embed model",
  memory: "Memory",
  prompt: "Chat prompt",
  summaryModel: "Summary model",
  thinking: "Thinking",
};

const labelPrefix: Record<DimensionKey, string> = {
  chatModel: "",
  contextLength: "context ",
  dreamPrompt: "Dream prompt ",
  embedModel: "embed ",
  memory: "memory ",
  prompt: "",
  summaryModel: "summary ",
  thinking: "thinking ",
};

const defaultLabelKeys: DimensionKey[] = ["chatModel", "prompt"];
const sweepDatePattern = /^(\d{4}-\d{2}-\d{2})(?![0-9])/u;

/** The dimensions that take more than one value in the sweep. */
export function varyingDimensions(axes: SweepAxes): DimensionKey[] {
  const varying = dimensionKeys.filter((key) => (axes[key]?.length ?? 0) > 1);
  return varying.length > 0 ? varying : defaultLabelKeys;
}

/** A short name for a setup: only the dimensions worth telling apart. */
export function setupLabel(
  setup: SetupDimensions,
  keys: readonly DimensionKey[] = defaultLabelKeys
): string {
  return keys.map((key) => `${labelPrefix[key]}${setup[key]}`).join(" · ");
}

/**
 * The day a sweep ran. The runner puts the date first in the sweep id. A file
 * time covers an id without one.
 */
export function sweepDateIso(
  sweepId: string,
  fileTime?: string
): string | undefined {
  const day = sweepDatePattern.exec(sweepId)?.[1];
  if (
    day !== undefined &&
    !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())
  ) {
    return `${day}T00:00:00Z`;
  }
  if (fileTime !== undefined && !Number.isNaN(new Date(fileTime).getTime())) {
    return fileTime;
  }
}

export function sweepHref(sweepId: string): string {
  return `/sweeps/${encodeURIComponent(sweepId)}`;
}

export function setupHref(sweepId: string, setupId: string): string {
  return `${sweepHref(sweepId)}/setups/${encodeURIComponent(setupId)}`;
}

/** The conversation reader for one item of a setup. */
export function itemHref(
  sweepId: string,
  setupId: string,
  item: { itemId: string; repeat: number }
): string {
  const query = new URLSearchParams({
    id: item.itemId,
    repeat: String(item.repeat),
  });
  return `${setupHref(sweepId, setupId)}/item?${query.toString()}`;
}

/** The Dream accuracy page for a setup, for one person when named, and only the sources with claims when asked. */
export function dreamHref(
  sweepId: string,
  setupId: string,
  person?: string,
  claimsOnly = false
): string {
  const base = `${setupHref(sweepId, setupId)}/dream`;
  const query = new URLSearchParams();
  if (person !== undefined) {
    query.set("person", person);
  }
  if (claimsOnly) {
    query.set("claims", "1");
  }
  const text = query.toString();
  return text.length === 0 ? base : `${base}?${text}`;
}

/** The side-by-side page. The filters are the compare page's own query. */
export function compareHref(
  sweepId: string,
  a: string,
  b: string,
  filters: Record<string, string | undefined> = {}
): string {
  const query = new URLSearchParams({ a, b });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value.length > 0) {
      query.set(key, value);
    }
  }
  return `${sweepHref(sweepId)}/compare?${query.toString()}`;
}

/** A route parameter, decoded when it is still percent-encoded. */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** How many checks failed in an item, including the checks on its turns. */
export function failedCheckCount(item: ReportItem): number {
  const failed = (checks: readonly { outcome: string }[]) =>
    checks.filter((check) => check.outcome === "fail").length;
  return (
    failed(item.checks) +
    item.turns.reduce((sum, turn) => sum + failed(turn.checks), 0)
  );
}

export type SetupReportState = "invalid" | "missing" | "ok" | "unsupported";

export interface RankingRow {
  costUsd: number | null;
  entry: RankingEntry;
  /** The hard checks that failed, with the count and detail when the report is there. */
  hardFailures: Pick<HardFailure, "count" | "detail" | "id">[];
  label: string;
  p90Ms: number | null;
  rank: number;
  state: SetupReportState;
  swapGrowthMB: number | null;
}

/** One row per ranking entry, in the runner's order. */
export function rankingRows(
  summary: SweepSummary,
  reports: ReadonlyMap<string, ParseOutcome<SetupReport>>
): RankingRow[] {
  const keys = varyingDimensions(summary.axes);
  return summary.ranking.map((entry, index) => {
    const outcome = reports.get(entry.setupId);
    const report = outcome?.kind === "ok" ? outcome.value : undefined;
    return {
      costUsd: report?.summary.costUsd ?? null,
      entry,
      hardFailures:
        report === undefined
          ? entry.hardFailed.map((id) => ({ count: 0, detail: "", id }))
          : report.summary.hardFailures,
      label:
        report === undefined ? entry.setupId : setupLabel(report.setup, keys),
      p90Ms: report?.summary.firstWordP90Ms ?? null,
      rank: index + 1,
      state: outcome?.kind ?? "missing",
      swapGrowthMB: report?.summary.swapGrowthMB ?? null,
    };
  });
}

export const rankingSortKeys = [
  "rank",
  "hard",
  "counted",
  "rubric",
  "spread",
  "median",
  "p90",
  "swap",
  "cost",
  "graded",
] as const;

export type RankingSortKey = (typeof rankingSortKeys)[number];
export type SortDirection = "asc" | "desc";

export interface RankingSort {
  dir: SortDirection;
  key: RankingSortKey;
}

/** The direction a column starts in: the best value first. */
const defaultDirections: Record<RankingSortKey, SortDirection> = {
  cost: "asc",
  counted: "asc",
  graded: "asc",
  hard: "asc",
  median: "asc",
  p90: "asc",
  rank: "asc",
  rubric: "desc",
  spread: "asc",
  swap: "asc",
};

export const defaultRankingSort: RankingSort = { dir: "asc", key: "rank" };

export function defaultDirection(key: RankingSortKey): SortDirection {
  return defaultDirections[key];
}

/** Reads `?sort=` and `?dir=`. Anything unknown gives the runner's order. */
export function parseRankingSort(
  sort: string | undefined,
  dir: string | undefined
): RankingSort {
  const key = rankingSortKeys.find((candidate) => candidate === sort);
  if (key === undefined) {
    return defaultRankingSort;
  }
  if (dir === "asc" || dir === "desc") {
    return { dir, key };
  }
  return { dir: defaultDirections[key], key };
}

function sortValue(row: RankingRow, key: RankingSortKey): number | null {
  switch (key) {
    case "rank":
      return row.rank;
    case "hard":
      return row.entry.hardFailed.length;
    case "counted":
      return row.entry.countedRate;
    case "rubric":
      return row.entry.rubricMean;
    case "spread":
      return row.entry.spread;
    case "median":
      return row.entry.firstWordMedianMs;
    case "p90":
      return row.p90Ms;
    case "swap":
      return row.swapGrowthMB;
    case "cost":
      return row.costUsd;
    case "graded":
      return row.entry.incomplete ? 1 : 0;
    default:
      return null;
  }
}

/** A sorted copy. A missing value goes last in either direction, and ties keep the runner's order. */
export function sortRankingRows(
  rows: readonly RankingRow[],
  sort: RankingSort
): RankingRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left === null || right === null) {
      if (left === right) {
        return a.rank - b.rank;
      }
      return left === null ? 1 : -1;
    }
    return sign * (left - right) || a.rank - b.rank;
  });
}

/** The sweep page sorted as asked. The runner's order has no query. */
export function rankingSortHref(sweepId: string, sort: RankingSort): string {
  if (
    sort.key === defaultRankingSort.key &&
    sort.dir === defaultRankingSort.dir
  ) {
    return sweepHref(sweepId);
  }
  const query = new URLSearchParams({ dir: sort.dir, sort: sort.key });
  return `${sweepHref(sweepId)}?${query.toString()}`;
}

/** What a click on a column header asks for: the other direction on the sorted column, the best-first direction on another. */
export function nextRankingSort(
  current: RankingSort,
  key: RankingSortKey
): RankingSort {
  if (current.key !== key) {
    return { dir: defaultDirections[key], key };
  }
  return { dir: current.dir === "asc" ? "desc" : "asc", key };
}

/** Newest first. A sweep with no date goes last, and ties break on the id. */
export function compareSweepsNewestFirst(
  a: { date?: string; id: string },
  b: { date?: string; id: string }
): number {
  if (a.date !== b.date) {
    if (a.date === undefined) {
      return 1;
    }
    if (b.date === undefined) {
      return -1;
    }
    return b.date.localeCompare(a.date);
  }
  return b.id.localeCompare(a.id);
}
