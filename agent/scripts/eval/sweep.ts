// Sweep files: `agent/evals/sweeps/<name>.yaml`.
//
// `loadSweep` reads one, applies the model-list overrides from the
// environment, and refuses settings the agent cannot honor yet. The result is
// a parsed `SweepFile` with every default filled in, the setups it expands to,
// and an id for the run.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadYaml } from "eve/evals/loaders";

import {
  expandSetups,
  parseSweepFile,
  type Setup,
  type SweepFile,
} from "../../evals/lib/schema.ts";
import { type Env, isNotFound } from "./env.ts";

const sweepNamePattern = /^[a-z0-9][a-z0-9-]*$/u;
const ollamaPrefix = "ollama/";

/** The model lists the environment can replace, and the sweep key each one replaces. */
export const MODEL_OVERRIDES = [
  ["SAGE_SUMMARY_MODELS", "summaryModels"],
  ["SAGE_EMBED_MODELS", "embedModels"],
  ["SAGE_CHAT_MODELS", "chatModels"],
] as const;

export function defaultSweepsDir(): string {
  return fileURLToPath(new URL("../../evals/sweeps", import.meta.url));
}

export function availableSweeps(dir = defaultSweepsDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length))
      .sort();
  } catch {
    return [];
  }
}

/** `a, b ,,c` becomes `["a", "b", "c"]`. A leading `ollama/` is dropped, as Chat does. */
export function splitModelList(raw: string): string[] {
  const models: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    const model = trimmed.startsWith(ollamaPrefix)
      ? trimmed.slice(ollamaPrefix.length)
      : trimmed;
    if (model.length > 0 && !models.includes(model)) {
      models.push(model);
    }
  }
  return models;
}

/** Replaces the model lists in a raw sweep document. Returns the keys it replaced. */
export function applyModelOverrides(
  doc: Record<string, unknown>,
  env: Env
): { applied: string[]; doc: Record<string, unknown> } {
  const next = { ...doc };
  const applied: string[] = [];
  for (const [variable, key] of MODEL_OVERRIDES) {
    const raw = env[variable];
    if (raw === undefined) {
      continue;
    }
    const models = splitModelList(raw);
    if (models.length > 0) {
      next[key] = models;
      applied.push(variable);
    }
  }
  return { applied, doc: next };
}

/**
 * The agent turns thinking on or off with one header. Levels such as `high`
 * parse in the sweep schema but would run as plain "on", so they stop here.
 */
export function thinkingProblems(sweep: Pick<SweepFile, "thinking">): string[] {
  return sweep.thinking
    .filter((value) => value !== "on" && value !== "off")
    .map(
      (value) =>
        `Thinking "${value}" is not supported yet. The agent only turns thinking on or off, so use "on" or "off".`
    );
}

export interface LoadedSweep {
  /** The sweep file's name, such as `smoke`. */
  name: string;
  /** Variables whose model lists replaced the file's. */
  overrides: string[];
  /** Absolute path of the YAML file. */
  path: string;
  setups: Setup[];
  sweep: SweepFile;
}

export async function loadSweep(
  name: string,
  env: Env = process.env,
  dir = defaultSweepsDir()
): Promise<LoadedSweep> {
  if (!sweepNamePattern.test(name)) {
    throw new Error(
      `"${name}" is not a sweep name. Use lowercase letters, digits, and dashes, such as "smoke".`
    );
  }
  const path = join(dir, `${name}.yaml`);
  let doc: Record<string, unknown>;
  try {
    doc = await loadYaml(path);
  } catch (error) {
    if (isNotFound(error)) {
      const known = availableSweeps(dir);
      throw new Error(
        `No sweep file ${path}.${known.length > 0 ? ` Sweeps here: ${known.join(", ")}.` : ""}`,
        { cause: error }
      );
    }
    throw error;
  }
  const { applied, doc: withOverrides } = applyModelOverrides(doc, env);
  const sweep = parseSweepFile(withOverrides, `sweep file ${name}.yaml`);
  const problems = thinkingProblems(sweep);
  if (problems.length > 0) {
    throw new Error(
      `Invalid sweep file ${name}.yaml\n  ${problems.join("\n  ")}`
    );
  }
  return { name, overrides: applied, path, setups: expandSetups(sweep), sweep };
}

const fractionPattern = /\.\d+Z$/u;

/**
 * `2026-11-10T031500Z-smoke`: the UTC time, then the sweep's name. The viewer
 * dates a sweep from the leading `YYYY-MM-DD`. The id has no `__`, which the
 * report file names use as a separator, and it is safe in a file name.
 */
export function makeSweepId(name: string, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll(":", "")
    .replace(fractionPattern, "Z");
  return `${stamp}-${name}`;
}

/** The sweep as JSON, with every default filled in. Eval files read this file. */
export function resolvedSweepJson(sweep: SweepFile): string {
  return `${JSON.stringify(sweep, null, 2)}\n`;
}
