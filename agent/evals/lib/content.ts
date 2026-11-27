/**
 * Where the eval content lives: the people, the Chat and Dream prompts, the
 * judge-check items, the calibration grades, and the sweep files. Sage ships
 * none of it. It is a checkout of the private sage-evals repo, at
 * `agent/evals/content/` unless `SAGE_EVAL_CONTENT` names another folder.
 *
 * The eval files that run the judge check and the calibration stay in Sage,
 * under `agent/evals/judge-check/` and `agent/evals/calibration/`. Only their
 * items and grades are content.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Names the content folder when it is not `agent/evals/content/`. */
export const ENV_EVAL_CONTENT = "SAGE_EVAL_CONTENT";

/** The folders the content has, each under the content root. */
export const CONTENT_FOLDERS = [
  "calibration",
  "data",
  "dream-prompts",
  "judge-check",
  "prompts",
  "sweeps",
] as const;
export type ContentFolder = (typeof CONTENT_FOLDERS)[number];

type Env = Readonly<Record<string, string | undefined>>;

const thisRepo = fileURLToPath(new URL("../../..", import.meta.url));

/** `agent/evals/content/` in a repo. */
export function contentRootIn(repo: string): string {
  return join(repo, "agent", "evals", "content");
}

/**
 * The content folder: `SAGE_EVAL_CONTENT` when it is set, else
 * `agent/evals/content/` in the repo `SAGE_REPO_ROOT` names, else in this repo.
 */
export function evalContentRoot(env: Env = process.env): string {
  const repo = env.SAGE_REPO_ROOT;
  return (
    contentRootFromEnv(env) ??
    contentRootIn(repo !== undefined && repo.length > 0 ? repo : thisRepo)
  );
}

/**
 * The content folder for an agent folder: `SAGE_EVAL_CONTENT` when it is set,
 * else `evals/content/` in it.
 */
export function evalContentRootForAgent(
  agentDir: string,
  env: Env = process.env
): string {
  return contentRootFromEnv(env) ?? join(agentDir, "evals", "content");
}

function contentRootFromEnv(env: Env): string | undefined {
  const fromEnv = env[ENV_EVAL_CONTENT];
  return fromEnv !== undefined && fromEnv.trim().length > 0
    ? resolve(fromEnv)
    : undefined;
}

/** One folder of the content, such as `sweeps` or `judge-check`. */
export function evalContentDir(folder: ContentFolder, env?: Env): string {
  return join(evalContentRoot(env), folder);
}

/** True when the content folder holds people and sweep files. */
export function hasEvalContent(env?: Env): boolean {
  const root = evalContentRoot(env);
  return (
    existsSync(join(root, "data", "people")) && existsSync(join(root, "sweeps"))
  );
}

/** What to do when there is no content, for a run or a test that needs it. */
export function missingContentMessage(env?: Env): string {
  return `No eval content at ${evalContentRoot(env)}. Clone the sage-evals repo there, or set ${ENV_EVAL_CONTENT} to its folder in agent/.env.local.`;
}

/**
 * For a test that reads the real content: `false` when it is there, else the
 * reason to skip, which node:test prints.
 */
export function skipWithoutContent(env?: Env): false | string {
  return hasEvalContent(env) ? false : missingContentMessage(env);
}
