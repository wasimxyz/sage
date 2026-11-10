// The runner's view of the people in `agent/evals/data/people/`.
//
// The loader itself is `agent/evals/lib/dataset.ts`. This file holds the
// interface the runner needs from it, finds that loader at run time so the
// runner can start (and explain itself) before the loader exists, and adds
// what only the runner needs: which people a sweep covers and how many items
// they hold.

import type { PersonCase } from "../../evals/lib/schema.ts";

export interface LoadedEntry {
  body: string;
  date: string;
  fileName: string;
  /** 1-based, in file name order. */
  index: number;
  stem: string;
  title: string;
  wordCount: number;
}

export interface LoadedPerson {
  dir: string;
  /** No `.md` entries: an empty journal. */
  empty: boolean;
  entries: LoadedEntry[];
  id: string;
  personCase: PersonCase;
}

export interface Manifest {
  cases: Record<string, { journalIds: number[] }>;
}

/** The part of `agent/evals/lib/dataset.ts` the runner calls. */
export interface DatasetApi {
  evalDataRoot(): string;
  loadPeople(opts?: { only?: string[] }): Promise<LoadedPerson[]>;
  validatePerson?(person: LoadedPerson, today: string): string[];
}

export class DatasetApiMissing extends Error {
  constructor(detail: string) {
    super(
      `${detail} The runner needs the people loader (loadPeople, loadPerson, evalDataRoot) in agent/evals/lib/dataset.ts.`
    );
    this.name = "DatasetApiMissing";
  }
}

const datasetUrl = new URL("../../evals/lib/dataset.ts", import.meta.url);

let injected: DatasetApi | null = null;

/** Tests hand in a fake loader. Pass null to go back to the real one. */
export function useDatasetApi(api: DatasetApi | null): void {
  injected = api;
}

export async function datasetApi(): Promise<DatasetApi> {
  if (injected !== null) {
    return injected;
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(datasetUrl.href)) as Record<string, unknown>;
  } catch (error) {
    throw new DatasetApiMissing(
      `Could not load agent/evals/lib/dataset.ts (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  for (const name of ["evalDataRoot", "loadPeople"]) {
    if (typeof loaded[name] !== "function") {
      throw new DatasetApiMissing(
        `agent/evals/lib/dataset.ts does not export ${name}.`
      );
    }
  }
  return loaded as unknown as DatasetApi;
}

export async function loadAllPeople(): Promise<LoadedPerson[]> {
  const api = await datasetApi();
  const people = await api.loadPeople();
  if (people.length === 0) {
    throw new Error(
      `No people found under ${api.evalDataRoot()}/people. Each person is a folder with a case.yaml.`
    );
  }
  return people;
}

export async function loadOnePerson(id: string): Promise<LoadedPerson> {
  const api = await datasetApi();
  const [person] = await api.loadPeople({ only: [id] });
  if (person === undefined) {
    throw new Error(`No person "${id}" under ${api.evalDataRoot()}/people.`);
  }
  return person;
}

export async function dataProblems(
  people: readonly LoadedPerson[],
  today: string
): Promise<string[]> {
  const api = await datasetApi();
  if (api.validatePerson === undefined) {
    return [];
  }
  const validate = api.validatePerson;
  return people.flatMap((person) =>
    validate(person, today).map((problem) => `${person.id}: ${problem}`)
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
 * A person is in the sweep when its tags match, or any opener or conversation
 * does. Their fact checks run in full once they are in.
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
  /** Replies the simulated user's conversations can reach, at maxTurns. */
  conversationTurns: number;
  conversations: number;
  entries: number;
  /** Fact, event, and summary references, which the judge scores. */
  judgedRefs: number;
  openers: number;
  /** Fact, event, summary, and retrieval references. */
  personChecks: number;
}

export function countItems(
  person: LoadedPerson,
  sweepTags: readonly string[]
): ItemCounts {
  const { chat, conversations, events, facts, openers, retrieval, summaries } =
    person.personCase;
  const openerCount = openers.filter((opener) =>
    itemMatchesTags(person, opener.tags, sweepTags)
  ).length;
  const matchingConversations = conversations.filter((conversation) =>
    itemMatchesTags(person, conversation.tags, sweepTags)
  );
  return {
    chatRefs: chat.length,
    conversationTurns: matchingConversations.reduce(
      (sum, conversation) => sum + conversation.maxTurns,
      0
    ),
    conversations: matchingConversations.length,
    entries: person.entries.length,
    judgedRefs: facts.length + events.length + summaries.length,
    openers: openerCount,
    personChecks:
      facts.length + events.length + summaries.length + retrieval.length,
  };
}
