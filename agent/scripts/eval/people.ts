// What the runner needs to know about the people in
// `agent/evals/content/data/people/`: which ones a sweep covers, and how much each one
// holds. The loader itself is `agent/evals/lib/dataset.ts`.

import {
  alsoEmptyConversations,
  needsEmptyJournalForConversations,
} from "../../evals/lib/conversations.ts";
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
  personExcluded,
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
      const wantingConversations = alsoEmptyConversations(person, []);
      if (wantingConversations.length > 0) {
        problems.push(
          `${person.id}: conversation ${wantingConversations.map((conversation) => conversation.id).join(", ")} is marked alsoEmpty, but there is no ${EMPTY_JOURNAL_PERSON} person with an empty journal to run it against.`
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
 * conversation does. Their fact checks run in full once they are in. A person
 * whose tags hold one of the sweep's `excludeTags` is never in.
 */
export function personInSweep(
  person: LoadedPerson,
  sweepTags: readonly string[],
  excludeTags: readonly string[] = []
): boolean {
  if (personExcluded(person, excludeTags)) {
    return false;
  }
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
 * The people a sweep covers. Openers and conversations marked `alsoEmpty` run
 * against the empty-journal person's Sage (`new-user`). So when the sweep sends
 * openers and a covered person has such an opener the tags pick, that person is
 * covered too, even if nothing of their own matches. Pass `openers: false` for
 * a sweep that sends none. Conversations work the same way, but only when the
 * caller passes `conversations: true`. People whose tags hold one of
 * `excludeTags` are left out, and so are their `alsoEmpty` items.
 */
export function selectPeople(
  people: readonly LoadedPerson[],
  sweepTags: readonly string[],
  options: {
    conversations?: boolean;
    excludeTags?: readonly string[];
    openers?: boolean;
  } = {}
): LoadedPerson[] {
  const chosen = people.filter((person) =>
    personInSweep(person, sweepTags, options.excludeTags)
  );
  const host = people.find(
    (person) => person.id === EMPTY_JOURNAL_PERSON && person.empty
  );
  const needsHost =
    (options.openers !== false && needsEmptyJournal(chosen, sweepTags)) ||
    (options.conversations === true &&
      needsEmptyJournalForConversations(chosen, sweepTags));
  if (host === undefined || chosen.includes(host) || !needsHost) {
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

/**
 * How many conversations other people run on the empty journal, and how many
 * turns they can take, for the person whose Sage has it. Zero for anyone else.
 */
export function emptyJournalConversationCount(
  person: LoadedPerson,
  covered: readonly LoadedPerson[],
  sweepTags: readonly string[]
): { conversations: number; turns: number } {
  const total = { conversations: 0, turns: 0 };
  if (person.id !== EMPTY_JOURNAL_PERSON || !person.empty) {
    return total;
  }
  for (const other of covered) {
    if (other.id === person.id) {
      continue;
    }
    for (const conversation of alsoEmptyConversations(other, sweepTags)) {
      total.conversations += 1;
      total.turns += conversation.maxTurns;
    }
  }
  return total;
}

export function countItems(
  person: LoadedPerson,
  sweepTags: readonly string[],
  emptyJournalOpeners = 0,
  emptyJournalConversations = { conversations: 0, turns: 0 }
): ItemCounts {
  const { chat, conversations, events, facts, openers, retrieval, summaries } =
    person.personCase;
  const matchingConversations = conversations.filter((conversation) =>
    itemMatchesTags(person, conversation.tags, sweepTags)
  );
  return {
    chatRefs: chat.length,
    conversations:
      matchingConversations.length + emptyJournalConversations.conversations,
    conversationTurns:
      matchingConversations.reduce(
        (sum, conversation) => sum + conversation.maxTurns,
        0
      ) + emptyJournalConversations.turns,
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
