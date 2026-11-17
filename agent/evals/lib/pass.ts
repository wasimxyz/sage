/**
 * Shared set-up for the eval files.
 *
 * eve imports every `*.eval.ts` file before it filters them, for every pass.
 * So each file must load cheaply, and must neither throw nor load anything
 * heavy when its variables are missing. These helpers give each file that:
 *
 * - With no `SAGE_EVAL_PERSON`, the file exports one skipped placeholder.
 * - A person with no items of this kind also gives a placeholder.
 * - If loading throws, the file exports one eval that throws the error. It
 *   only runs when that file's evals are selected, so a broken person file
 *   cannot stop an unrelated pass.
 */
import { defineEval } from "eve/evals";

import { type LoadedPerson, loadPerson } from "./dataset.ts";
import { ENV_PERSON, readPassEnv } from "./schema.ts";
import { type PassSetup, readPassSetup } from "./setup.ts";
import { skipEval } from "./skip.ts";

export type EvalDefinition = ReturnType<typeof defineEval>;

export interface PersonPass {
  pass: PassSetup;
  person: LoadedPerson;
}

export interface PersonEvalDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Loads a person. Defaults to `loadPerson` from `dataset.ts`. */
  loadPerson?: (id: string) => Promise<LoadedPerson>;
}

/** An eval that throws `error` when it runs. */
export function failEval(description: string, error: unknown): EvalDefinition {
  const failure = error instanceof Error ? error : new Error(String(error));
  return defineEval({
    description: `${description}: ${failure.message}`,
    test() {
      throw failure;
    },
  });
}

/** Runs `load`. An empty list becomes a placeholder, and a throw becomes a failing eval. */
export async function guardedEvals(
  kind: string,
  load: () => Promise<EvalDefinition[]>,
  emptyReason: string
): Promise<EvalDefinition | EvalDefinition[]> {
  try {
    const evals = await load();
    return evals.length > 0 ? evals : skipEval(emptyReason);
  } catch (error) {
    return failEval(`Could not load the ${kind} evals`, error);
  }
}

/** The tags of a person's evals: the person's own tags, plus the pass's name. */
export function tagsFor(
  person: Pick<LoadedPerson, "personCase">,
  pipeline: string
): string[] {
  return [...new Set([...person.personCase.tags, pipeline])];
}

/**
 * The evals of one kind for the person this pass is about
 * (`SAGE_EVAL_PERSON`). `build` returns one eval per item.
 */
export function personEvals(
  kind: string,
  build: (context: PersonPass) => EvalDefinition[],
  deps: PersonEvalDeps = {}
): Promise<EvalDefinition | EvalDefinition[]> {
  const env = deps.env ?? process.env;
  const personId = readPassEnv(env).person;
  if (personId === undefined) {
    return Promise.resolve(
      skipEval(
        `No person for this pass. Run make eval so the runner sets ${ENV_PERSON}.`
      )
    );
  }
  return guardedEvals(
    kind,
    async () => {
      const person = await (deps.loadPerson ?? loadPerson)(personId);
      return build({ pass: readPassSetup(env), person });
    },
    `${personId} has no ${kind} items.`
  );
}
