import type { EvalManifest } from "./types.ts";

export function parseManifest(raw: string): EvalManifest {
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("cases" in parsed) ||
    parsed.cases === null ||
    typeof parsed.cases !== "object"
  ) {
    return { cases: {} };
  }
  const cases: EvalManifest["cases"] = {};
  for (const [id, value] of Object.entries(
    parsed.cases as Record<string, unknown>
  )) {
    if (
      value === null ||
      typeof value !== "object" ||
      !("journalIds" in value) ||
      !Array.isArray(value.journalIds)
    ) {
      continue;
    }
    const journalIds = value.journalIds.filter(
      (item): item is number => typeof item === "number"
    );
    cases[id] = { journalIds };
  }
  return { cases };
}
