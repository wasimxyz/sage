// The list of work, in the order the runner does it.
//
//   memory -> (summary model, embed model, Dream prompt) -> person
//     -> Chat prompt -> chat model -> context length -> thinking
//
// The outer loops restart Sage (and its Ollama), because each Sage holds one
// person's journal. The inner loops change only what the Chat agent asks for,
// so a model stays loaded while the settings around it change.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  dreamKeyId,
  type Memory,
  type Setup,
  type SweepFile,
  type TestKind,
} from "../../evals/lib/schema.ts";
import {
  countItems,
  emptyJournalOpenerCount,
  type ItemCounts,
  type LoadedPerson,
} from "./people.ts";

/** The eval id of Dream accuracy, which needs the snapshot's folder for its grades. */
export const DREAM_ACCURACY_EVAL = "person/dream-accuracy";

export const PASS_NAMES = ["person", "chat", "grade"] as const;
export type PassName = (typeof PASS_NAMES)[number];

/**
 * The eve eval ids each test kind runs, per pass. An id is a file under
 * `agent/evals/` without `.eval.ts`, or a folder. Ids with no file yet are
 * left out and reported, so a sweep can name a test before its files land.
 *
 * `facts` and `openers` share one grade eval, `grade/replies`, which grades
 * every reply in the transcripts. `resolveTests` lists an id once, so a sweep
 * with both runs one grade pass and each reply is graded once.
 */
export const TEST_EVALS: Readonly<
  Record<TestKind, Partial<Record<PassName, readonly string[]>>>
> = {
  calibration: {},
  conversations: {
    chat: ["chat/conversations"],
    grade: ["grade/conversations"],
  },
  "dream-accuracy": { person: [DREAM_ACCURACY_EVAL] },
  facts: { chat: ["chat/facts"], grade: ["grade/replies"] },
  "head-to-head": {},
  openers: { chat: ["chat/openers"], grade: ["grade/replies"] },
  person: {
    person: ["person/extraction", "person/summaries", "person/retrieval"],
  },
};

/** Test kinds the runner does not start yet. They arrive with their own passes. */
export const DEFERRED_TESTS: readonly TestKind[] = [
  "calibration",
  "head-to-head",
];

export type PassPrefixes = Record<PassName, string[]>;

export interface ResolvedTests {
  /** Test kinds the runner does not run yet. */
  deferred: TestKind[];
  /** Eval ids a test asked for that have no file. */
  missing: string[];
  prefixes: PassPrefixes;
}

function evalExists(evalsDir: string, id: string): boolean {
  if (existsSync(join(evalsDir, `${id}.eval.ts`))) {
    return true;
  }
  try {
    return statSync(join(evalsDir, id)).isDirectory();
  } catch {
    return false;
  }
}

export function resolveTests(
  tests: readonly TestKind[],
  evalsDir: string
): ResolvedTests {
  const prefixes: PassPrefixes = { chat: [], grade: [], person: [] };
  const missing: string[] = [];
  const deferred: TestKind[] = [];
  for (const test of tests) {
    if (DEFERRED_TESTS.includes(test)) {
      deferred.push(test);
      continue;
    }
    for (const pass of PASS_NAMES) {
      for (const id of TEST_EVALS[test][pass] ?? []) {
        if (!evalExists(evalsDir, id)) {
          missing.push(id);
        } else if (!prefixes[pass].includes(id)) {
          prefixes[pass].push(id);
        }
      }
    }
  }
  return { deferred, missing, prefixes };
}

export interface PlanPerson {
  counts: ItemCounts;
  empty: boolean;
  id: string;
}

/** Setups that share a Chat prompt, in the order they run for one person. */
export interface PlanPrompt {
  prompt: string;
  setups: Setup[];
}

/** Setups that share one Dream snapshot per person. */
export interface PlanGroup {
  dreamKeyId: string;
  dreamPrompt: string;
  embedModel: string;
  memory: Memory;
  prompts: PlanPrompt[];
  summaryModel: string;
}

export interface PlanStats {
  chatPasses: number;
  eveDevStarts: number;
  gradePasses: number;
  modelLoads: number;
  personPasses: number;
  sageStarts: number;
}

export interface RunPlan {
  /**
   * False when no test of the sweep sends a Chat message, such as the `dream`
   * sweep. Then no Chat model is pulled or loaded, and no Chat server starts.
   */
  chat: boolean;
  groups: PlanGroup[];
  memoryValues: Memory[];
  people: PlanPerson[];
  setups: Setup[];
  stats: PlanStats;
}

/** True when the sweep has an eval that talks to the Chat agent. */
export function needsChat(prefixes: PassPrefixes): boolean {
  return prefixes.chat.length > 0;
}

function groupSetups(setups: readonly Setup[]): PlanGroup[] {
  const groups: PlanGroup[] = [];
  for (const setup of setups) {
    const id = dreamKeyId(setup);
    let group = groups.find((candidate) => candidate.dreamKeyId === id);
    if (group === undefined) {
      group = {
        dreamKeyId: id,
        dreamPrompt: setup.dreamPrompt,
        embedModel: setup.embedModel,
        memory: setup.memory,
        prompts: [],
        summaryModel: setup.summaryModel,
      };
      groups.push(group);
    }
    let prompt = group.prompts.find(
      (candidate) => candidate.prompt === setup.prompt
    );
    if (prompt === undefined) {
      prompt = { prompt: setup.prompt, setups: [] };
      group.prompts.push(prompt);
    }
    prompt.setups.push(setup);
  }
  return groups;
}

function countModelLoads(groups: readonly PlanGroup[], people: number): number {
  // Each Sage start also starts its own Ollama, so the first pass of a person
  // loads its model. Later passes load again only when the model or the
  // context length changes.
  let loads = 0;
  for (const group of groups) {
    let previous: string | null = null;
    for (const prompt of group.prompts) {
      for (const setup of prompt.setups) {
        const key = `${setup.chatModel}\0${setup.contextLength}`;
        if (key !== previous) {
          loads += 1;
          previous = key;
        }
      }
    }
  }
  return loads * people;
}

export function buildPlan(
  setups: readonly Setup[],
  people: readonly LoadedPerson[],
  sweep: Pick<SweepFile, "tags">,
  options: { chat?: boolean } = {}
): RunPlan {
  const chat = options.chat ?? true;
  const groups = groupSetups(setups);
  const planPeople: PlanPerson[] = people.map((person) => ({
    counts: countItems(
      person,
      sweep.tags,
      emptyJournalOpenerCount(person, people, sweep.tags)
    ),
    empty: person.empty,
    id: person.id,
  }));
  const memoryValues: Memory[] = [];
  for (const setup of setups) {
    if (!memoryValues.includes(setup.memory)) {
      memoryValues.push(setup.memory);
    }
  }
  const personCount = planPeople.length;
  const promptCount = groups.reduce(
    (sum, group) => sum + group.prompts.length,
    0
  );
  return {
    chat,
    groups,
    memoryValues,
    people: planPeople,
    setups: [...setups],
    stats: {
      chatPasses: chat ? setups.length * personCount : 0,
      eveDevStarts: chat ? promptCount * personCount : 0,
      gradePasses: chat ? setups.length * personCount : 0,
      modelLoads: chat ? countModelLoads(groups, personCount) : 0,
      personPasses: groups.length * personCount,
      sageStarts: groups.length * personCount,
    },
  };
}

/** One line per group, for the plan the runner prints. */
export function describePlan(plan: RunPlan): string[] {
  const lines: string[] = [];
  for (const group of plan.groups) {
    const setupCount = group.prompts.reduce(
      (sum, prompt) => sum + prompt.setups.length,
      0
    );
    const chatPrompts = plan.chat
      ? `, ${group.prompts.length} Chat prompt${group.prompts.length === 1 ? "" : "s"}`
      : "";
    lines.push(
      `memory ${group.memory}, summary ${group.summaryModel}, embed ${group.embedModel}, Dream prompt ${group.dreamPrompt}: ${setupCount} setup${setupCount === 1 ? "" : "s"}${chatPrompts}`
    );
  }
  lines.push(
    `${plan.people.length} ${plan.people.length === 1 ? "person" : "people"}: ${plan.people.map((person) => person.id).join(", ")}`
  );
  const { stats } = plan;
  const sageStarts = `${stats.sageStarts} Sage start${stats.sageStarts === 1 ? "" : "s"}`;
  lines.push(
    plan.chat
      ? `${sageStarts}, ${stats.eveDevStarts} Chat server start${stats.eveDevStarts === 1 ? "" : "s"}, about ${stats.modelLoads} model load${stats.modelLoads === 1 ? "" : "s"}`
      : `${sageStarts}, no Chat (the tests send no message)`
  );
  return lines;
}

/** The distinct values of one setup field, in plan order. */
export function distinct<K extends keyof Setup>(
  setups: readonly Setup[],
  key: K
): Setup[K][] {
  const seen: Setup[K][] = [];
  for (const setup of setups) {
    if (!seen.includes(setup[key])) {
      seen.push(setup[key]);
    }
  }
  return seen;
}
