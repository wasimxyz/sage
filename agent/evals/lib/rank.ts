export type RankOrder =
  | "current-first"
  | "stale-first"
  | "current-only"
  | "stale-only"
  | "missing";

export function compareCurrentAndStale(
  rankedTexts: readonly string[],
  current: string,
  stale: string
): RankOrder {
  const currentIndex = firstMatchIndex(rankedTexts, current);
  const staleIndex = firstMatchIndex(rankedTexts, stale);
  if (currentIndex === -1 && staleIndex === -1) {
    return "missing";
  }
  if (currentIndex === -1) {
    return "stale-only";
  }
  if (staleIndex === -1) {
    return "current-only";
  }
  return currentIndex <= staleIndex ? "current-first" : "stale-first";
}

export function currentOutranksStale(order: RankOrder): boolean {
  return order === "current-first" || order === "current-only";
}

function firstMatchIndex(texts: readonly string[], claim: string): number {
  const needle = normalize(claim);
  if (needle.length === 0) {
    return -1;
  }
  return texts.findIndex((text) => {
    const haystack = normalize(text);
    return haystack.includes(needle) || needle.includes(haystack);
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
