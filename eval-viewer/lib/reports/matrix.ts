import { formatDate } from "./format.ts";
import type { RunSummary } from "./types.ts";

export function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function resolveEmbedModel(
  runs: RunSummary[],
  requested: string | undefined
): string {
  const embeds = uniqueInOrder(runs.map((run) => run.embedModel));
  if (requested !== undefined && embeds.includes(requested)) {
    return requested;
  }
  return embeds[0] ?? "";
}

export function filterByEmbed(
  runs: RunSummary[],
  embedModel: string
): RunSummary[] {
  return runs.filter((run) => run.embedModel === embedModel);
}

export function dreamChatKey(dreamModel: string, chatModel: string): string {
  return `${dreamModel}::${chatModel}`;
}

export function latestByDreamChat(runs: RunSummary[]): Map<string, RunSummary> {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    const key = dreamChatKey(run.dreamModel, run.chatModel);
    const current = latest.get(key);
    if (current === undefined || run.startedAt > current.startedAt) {
      latest.set(key, run);
    }
  }
  return latest;
}

export function groupRunsByDate(
  runs: RunSummary[]
): { key: string; label: string; runs: RunSummary[] }[] {
  const groups: { key: string; label: string; runs: RunSummary[] }[] = [];
  const indexByKey = new Map<string, number>();
  for (const run of runs) {
    const key = utcDateKey(run.startedAt);
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({
        key,
        label: formatDate(run.startedAt),
        runs: [run],
      });
      continue;
    }
    const group = groups.at(existing);
    if (group === undefined) {
      continue;
    }
    group.runs.push(run);
  }
  return groups;
}

function utcDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toISOString().slice(0, 10);
}
