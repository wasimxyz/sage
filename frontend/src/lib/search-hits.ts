export type SearchTab = "all" | "conversations" | "journal" | "memories";

export function searchHitsReady(
  tab: SearchTab,
  trimmedQuery: string,
  journalQuery: string,
  conversationQuery: string,
  memoryQuery: string,
  memoryEnabled = true
): boolean {
  if (trimmedQuery.length === 0) {
    return false;
  }
  if (tab === "journal") {
    return journalQuery === trimmedQuery;
  }
  if (tab === "conversations") {
    return conversationQuery === trimmedQuery;
  }
  if (tab === "memories") {
    return memoryEnabled && memoryQuery === trimmedQuery;
  }
  return (
    journalQuery === trimmedQuery &&
    conversationQuery === trimmedQuery &&
    (!memoryEnabled || memoryQuery === trimmedQuery)
  );
}

export function visibleHits<J, C, M>(
  tab: SearchTab,
  journalHits: readonly J[],
  conversationHits: readonly C[],
  memoryHits: readonly M[]
): (
  | { kind: "journal"; result: J }
  | { kind: "conversation"; result: C }
  | { kind: "memory"; result: M }
)[] {
  if (tab === "journal") {
    return journalHits.map((result) => ({ kind: "journal", result }));
  }
  if (tab === "conversations") {
    return conversationHits.map((result) => ({
      kind: "conversation",
      result,
    }));
  }
  if (tab === "memories") {
    return memoryHits.map((result) => ({ kind: "memory", result }));
  }
  return [
    ...journalHits.map((result) => ({ kind: "journal" as const, result })),
    ...conversationHits.map((result) => ({
      kind: "conversation" as const,
      result,
    })),
    ...memoryHits.map((result) => ({ kind: "memory" as const, result })),
  ];
}
