export type SearchTab = "all" | "conversations" | "journal" | "memories";

/**
 * The query the stored hits for this tab answer, or "" when the sources the
 * tab needs answer different queries. The dialog keeps these hits on screen
 * while the next query runs, so typing does not blank the list.
 */
export function settledSearchQuery(
  tab: SearchTab,
  journalQuery: string,
  conversationQuery: string,
  memoryQuery: string,
  memoryEnabled = true
): string {
  if (tab === "journal") {
    return journalQuery;
  }
  if (tab === "conversations") {
    return conversationQuery;
  }
  if (tab === "memories") {
    return memoryEnabled ? memoryQuery : "";
  }
  if (journalQuery !== conversationQuery) {
    return "";
  }
  if (memoryEnabled && memoryQuery !== journalQuery) {
    return "";
  }
  return journalQuery;
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
