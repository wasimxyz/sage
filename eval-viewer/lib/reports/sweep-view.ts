import {
  type DimensionKey,
  dimensionKeys,
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
  entry: RankingEntry;
  label: string;
  p90Ms: number | null;
  rank: number;
  state: SetupReportState;
}

/** One row per ranking entry, in the runner's order. */
export function rankingRows(
  summary: SweepSummary,
  reports: ReadonlyMap<string, ParseOutcome<SetupReport>>
): RankingRow[] {
  const keys = varyingDimensions(summary.axes);
  return summary.ranking.map((entry, index) => {
    const outcome = reports.get(entry.setupId);
    return {
      entry,
      label:
        outcome?.kind === "ok"
          ? setupLabel(outcome.value.setup, keys)
          : entry.setupId,
      p90Ms:
        outcome?.kind === "ok" ? outcome.value.summary.firstWordP90Ms : null,
      rank: index + 1,
      state: outcome?.kind ?? "missing",
    };
  });
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
