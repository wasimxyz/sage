// What the runner needs to know about the people in
// `agent/evals/data/people/`: which ones a sweep covers, and how much each one
// holds. The loader itself is `agent/evals/lib/dataset.ts`.

import {
  evalDataRoot,
  type LoadedPerson,
  loadPeople,
  validatePerson,
} from "../../evals/lib/dataset.ts";

export type { LoadedEntry, LoadedPerson } from "../../evals/lib/dataset.ts";

export async function loadAllPeople(): Promise<LoadedPerson[]> {
  const people = await loadPeople();
  if (people.length === 0) {
    throw new Error(
      `No people found under ${evalDataRoot()}/people. Each person is a folder with a case.yaml.`
    );
  }
  return people;
}

/** Problems in the people's files as of `today`, one line each, led by the person's id. */
export function dataProblems(
  people: readonly LoadedPerson[],
  today: string
): string[] {
  return people.flatMap((person) =>
    validatePerson(person, today).map((problem) => `${person.id}: ${problem}`)
  );
}

// ---------------------------------------------------------------------------
// Which people a sweep covers
// ---------------------------------------------------------------------------

function intersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((value) => b.includes(value));
}

/**
 * An item matches when its own tags or its person's tags share a tag with the
 * sweep. A sweep with no tags matches everything.
 */
export function itemMatchesTags(
  person: LoadedPerson,
  itemTags: readonly string[],
  sweepTags: readonly string[]
): boolean {
  if (sweepTags.length === 0) {
    return true;
  }
  return (
    intersects(person.personCase.tags, sweepTags) ||
    intersects(itemTags, sweepTags)
  );
}

/**
 * A person is in the sweep when their tags match, or any opener or
 * conversation does. Their fact checks run in full once they are in.
 */
export function personInSweep(
  person: LoadedPerson,
  sweepTags: readonly string[]
): boolean {
  if (sweepTags.length === 0) {
    return true;
  }
  const { conversations, openers } = person.personCase;
  return (
    intersects(person.personCase.tags, sweepTags) ||
    openers.some((opener) => intersects(opener.tags, sweepTags)) ||
    conversations.some((conversation) =>
      intersects(conversation.tags, sweepTags)
    )
  );
}

export function selectPeople(
  people: readonly LoadedPerson[],
  sweepTags: readonly string[]
): LoadedPerson[] {
  return people.filter((person) => personInSweep(person, sweepTags));
}

// ---------------------------------------------------------------------------
// How much a person holds
// ---------------------------------------------------------------------------

export interface ItemCounts {
  chatRefs: number;
  conversations: number;
  /** Replies the simulated user's conversations can reach, at maxTurns. */
  conversationTurns: number;
  entries: number;
  /** Fact, event, and summary references, which the judge scores. */
  judgedRefs: number;
  openers: number;
  /** Fact, event, summary, and retrieval references. */
  personChecks: number;
  /** Summary references, the only judged references a memory-off Dream keeps. */
  summaryRefs: number;
}

export function countItems(
  person: LoadedPerson,
  sweepTags: readonly string[]
): ItemCounts {
  const { chat, conversations, events, facts, openers, retrieval, summaries } =
    person.personCase;
  const matchingConversations = conversations.filter((conversation) =>
    itemMatchesTags(person, conversation.tags, sweepTags)
  );
  return {
    chatRefs: chat.length,
    conversations: matchingConversations.length,
    conversationTurns: matchingConversations.reduce(
      (sum, conversation) => sum + conversation.maxTurns,
      0
    ),
    entries: person.entries.length,
    judgedRefs: facts.length + events.length + summaries.length,
    openers: openers.filter((opener) =>
      itemMatchesTags(person, opener.tags, sweepTags)
    ).length,
    personChecks:
      facts.length + events.length + summaries.length + retrieval.length,
    summaryRefs: summaries.length,
  };
}
