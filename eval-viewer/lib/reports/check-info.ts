// Which tier each check id belongs to, and a name to show for it. Keep these
// lists in step with CHECK_TIERS in agent/evals/lib/schema.ts. An id this file
// does not know shows as itself, in the "other" tier.

export type CheckTier =
  | "counted"
  | "hard"
  | "other"
  | "rubric"
  | "search"
  | "slip";

const checkInfo: Record<string, { label: string; tier: CheckTier }> = {
  "asks-before-exercise": { label: "Asks before an exercise", tier: "counted" },

  assumptions: { label: "Assumptions", tier: "slip" },

  collaboration: { label: "Collaboration", tier: "rubric" },
  "crisis-handled": { label: "Crisis handled", tier: "hard" },
  "dream-supported": { label: "Dream supported", tier: "counted" },
  "drops-after-no": { label: "Drops it after a no", tier: "counted" },
  "event-source": { label: "Event source is right", tier: "counted" },
  "fast-enough": { label: "Fast enough", tier: "hard" },
  "fits-in-memory": { label: "Fits in memory", tier: "hard" },
  "fits-moment": { label: "Fits the moment", tier: "rubric" },
  focus: { label: "Focus", tier: "rubric" },
  "follows-lead": { label: "Follows their lead", tier: "rubric" },
  formatting: { label: "Formatting", tier: "slip" },

  "found-needed": { label: "Found what it needed", tier: "search" },
  "ignores-injected": {
    label: "Ignores instructions in entries",
    tier: "counted",
  },
  "journal-right": { label: "Gets the journal right", tier: "counted" },
  "journal-use": { label: "Journal use", tier: "rubric" },
  "keeps-track": { label: "Keeps track", tier: "rubric" },
  "many-questions": { label: "More than one question", tier: "slip" },
  "memory-returns": { label: "Memory returns the item", tier: "counted" },
  "missed-search": { label: "Missed search", tier: "search" },
  "needless-search": { label: "Needless search", tier: "search" },
  "no-brushing-off": { label: "No brushing off", tier: "counted" },
  "no-harmful-agreement": { label: "No harmful agreement", tier: "counted" },
  "no-overreach": { label: "No overreach or false claims", tier: "counted" },
  "no-runaway-search": { label: "No runaway searching", tier: "counted" },
  "no-severe-unsupported": {
    label: "No severe unsupported claim",
    tier: "hard",
  },
  "not-chat-length": { label: "Not chat length", tier: "slip" },
  "questions-help": { label: "Questions help", tier: "rubric" },
  "retrieval-top-hit": { label: "Right entry is the top hit", tier: "counted" },
  "right-help": { label: "Right kind of help", tier: "rubric" },
  "search-quality": { label: "Search quality", tier: "rubric" },
  "shows-internals": { label: "Shows internals", tier: "slip" },
  "stops-feeding-loop": { label: "Stops feeding a loop", tier: "counted" },
  "summary-exists": { label: "Summary exists", tier: "counted" },
  "turn-works": { label: "Turn works", tier: "counted" },
  understanding: { label: "Understanding", tier: "rubric" },
  "user-rating": { label: "Simulated user's rating", tier: "rubric" },
  warmth: { label: "Warmth", tier: "rubric" },
  "weighs-events": { label: "Weighs events right", tier: "rubric" },
  "wrong-pronouns": { label: "Wrong pronouns", tier: "slip" },
};

export function checkTier(id: string): CheckTier {
  return checkInfo[id]?.tier ?? "other";
}

export function checkLabel(id: string): string {
  return checkInfo[id]?.label ?? id;
}

export const tierLabel: Record<CheckTier, string> = {
  counted: "Counted",
  hard: "Hard",
  other: "Other",
  rubric: "Rubric",
  search: "Search",
  slip: "Slip",
};
