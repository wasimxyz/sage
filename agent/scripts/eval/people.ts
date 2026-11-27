// What the runner needs to know about the people in
// `agent/evals/data/people/`: which ones a sweep covers, and how much each one
// holds. The loader itself is `agent/evals/lib/dataset.ts`.

import {
  evalDataRoot,
  type LoadedPerson,
  loadPeople,
  validatePerson,
} from "../../evals/lib/dataset.ts";
import {
  alsoEmptyOpeners,
  EMPTY_JOURNAL_PERSON,
  needsEmptyJournal,
  itemMatchesTags as tagsMatch,
} from "../../evals/lib/openers.ts";

export type {
  LoadedChat,
  LoadedEntry,
  LoadedPerson,
} from "../../evals/lib/dataset.ts";

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
  const problems = people.flatMap((person) =>
    validatePerson(person, today).map((problem) => `${person.id}: ${problem}`)
  );
  const host = people.find((person) => person.id === EMPTY_JOURNAL_PERSON);
  if (host !== undefined && !host.empty) {
    problems.push(
      `${host.id}: this person stands for the empty journal, so it must have no entries.`
    );
  }
  if (host === undefined) {
    for (const person of people) {
      const wanting = alsoEmptyOpeners(person, []);
      if (wanting.length > 0) {
        problems.push(
          `${person.id}: opener ${wanting.map((opener) => opener.id).join(", ")} is marked alsoEmpty, but there is no ${EMPTY_JOURNAL_PERSON} person with an empty journal to run it against.`
        );
      }
    }
  }
  return problems;
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
  return tagsMatch(person.personCase.tags, itemTags, sweepTags);
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

/**
 * The people a sweep covers. Openers marked `alsoEmpty` run against the
 * empty-journal person's Sage (`new-user`). So when the sweep sends openers
 * and a covered person has such an opener the tags pick, that person is
 * covered too, even if nothing of their own matches. Pass `openers: false`
 * for a sweep that sends none.
 */
export function selectPeople(
  people: readonly LoadedPerson[],
  sweepTags: readonly string[],
  options: { openers?: boolean } = {}
): LoadedPerson[] {
  const chosen = people.filter((person) => personInSweep(person, sweepTags));
  const host = people.find(
    (person) => person.id === EMPTY_JOURNAL_PERSON && person.empty
  );
  if (
    options.openers === false ||
    host === undefined ||
    chosen.includes(host) ||
    !needsEmptyJournal(chosen, sweepTags)
  ) {
    return chosen;
  }
  return people.filter((person) => person === host || chosen.includes(person));
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
  /** Openers to send. The empty-journal person's include other people's `alsoEmpty` ones. */
  openers: number;
  /** Fact, event, summary, and retrieval references. */
  personChecks: number;
  /** Summary references, the only judged references a memory-off Dream keeps. */
  summaryRefs: number;
}

/**
 * How many openers other people send on the empty journal, for the person
 * whose Sage has it. Zero for anyone else.
 */
export function emptyJournalOpenerCount(
  person: LoadedPerson,
  covered: readonly LoadedPerson[],
  sweepTags: readonly string[]
): number {
  if (person.id !== EMPTY_JOURNAL_PERSON || !person.empty) {
    return 0;
  }
  return covered
    .filter((other) => other.id !== person.id)
    .reduce((sum, other) => sum + alsoEmptyOpeners(other, sweepTags).length, 0);
}

export function countItems(
  person: LoadedPerson,
  sweepTags: readonly string[],
  emptyJournalOpeners = 0
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
    openers:
      openers.filter((opener) =>
        itemMatchesTags(person, opener.tags, sweepTags)
      ).length + emptyJournalOpeners,
    personChecks:
      facts.length + events.length + summaries.length + retrieval.length,
    summaryRefs: summaries.length,
  };
}
