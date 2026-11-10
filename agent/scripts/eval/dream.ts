// Dream for one person: restore a cached snapshot, or seed the journal, let
// Dream run, and snapshot the result.
//
// The cache key is per person (see lib/cache.ts), so editing one person's
// entries runs Dream again for that person only.

import { join } from "node:path";

import {
  type CacheKeyParts,
  cachedDreamEntry,
  computeCacheKey,
  evalCacheDir,
  evalCacheEnabled,
  fetchOllamaDigests,
  loadCacheKeyParts,
  repoRoot,
  restoreDreamCache,
  snapshotDreamRun,
} from "../../evals/lib/cache.ts";
import { evalDataRoot } from "../../evals/lib/dataset.ts";
import type { Memory } from "../../evals/lib/schema.ts";
import { withoutSecrets } from "./env.ts";
import { ollamaApiBase } from "./ollama.ts";
import type { LoadedPerson } from "./people.ts";
import { runCommand, succeeded } from "./proc.ts";

export interface DreamUnit {
  dreamPrompt: string;
  embedModel: string;
  memory: Memory;
  person: LoadedPerson;
  summaryModel: string;
}

export interface DreamKey {
  hit: boolean;
  key: string;
  parts: CacheKeyParts;
}

/** Looks up Ollama's digest for each model. A model Ollama lacks has none. */
export type DigestLookup = (
  models: string[]
) => Promise<Partial<Record<string, string>>>;

/**
 * A lookup that reads `/api/tags` once, from an Ollama server that is up now,
 * and answers from that copy later. No server runs between units, but the
 * digests of the pulled models do not change during a run.
 */
export async function snapshotDigests(
  models: readonly string[],
  ollamaHost: string
): Promise<DigestLookup> {
  let known: Partial<Record<string, string>> = {};
  try {
    known = await fetchOllamaDigests([...models], ollamaApiBase(ollamaHost));
  } catch {
    console.warn(
      "Could not read Ollama model digests; cache keys use names only."
    );
  }
  return (wanted) =>
    Promise.resolve(
      Object.fromEntries(
        wanted.flatMap((model) => {
          const digest = known[model];
          return digest === undefined ? [] : [[model, digest]];
        })
      )
    );
}

/** The cache key for a unit, and whether a snapshot exists for it. */
export async function dreamKeyFor(
  unit: DreamUnit,
  digests: DigestLookup
): Promise<DreamKey> {
  const parts = await loadCacheKeyParts(
    {
      dreamPrompt: unit.dreamPrompt,
      embedModel: unit.embedModel,
      memory: unit.memory,
      person: unit.person.id,
      summaryModel: unit.summaryModel,
    },
    digests
  );
  const key = computeCacheKey(parts);
  return {
    hit: evalCacheEnabled() && cachedDreamEntry(key, evalCacheDir()) !== null,
    key,
    parts,
  };
}

/** True when this person's journal has anything for Dream to read. */
export function needsDream(person: LoadedPerson): boolean {
  return person.entries.length > 0;
}

/** Copies a cached snapshot into the data directory. Run it before Sage starts. */
export function restoreSnapshot(options: {
  dataDir: string;
  key: string;
  manifestPath: string;
}): boolean {
  if (!evalCacheEnabled()) {
    return false;
  }
  return restoreDreamCache({ ...options, cacheDir: evalCacheDir() });
}

/** Environment for `seed-dataset.ts`. It carries no credentials. */
export function seedEnv(options: {
  automationCwd: string;
  dataDir: string;
  manifestPath: string;
  personId: string;
}): Record<string, string> {
  return {
    ...withoutSecrets(),
    SAGE_AUTOMATION_CWD: options.automationCwd,
    SAGE_DATA_DIR: options.dataDir,
    SAGE_EVAL_DATA: evalDataRoot(),
    SAGE_EVAL_MANIFEST: options.manifestPath,
    SAGE_EVAL_PERSON: options.personId,
    SAGE_REPO_ROOT: repoRoot(),
  };
}

/** Seeds the person's journal through the bridge and waits for Dream. */
export async function seedPerson(options: {
  automationCwd: string;
  dataDir: string;
  logFile: string;
  manifestPath: string;
  personId: string;
  root: string;
}): Promise<void> {
  const script = join(options.root, "agent", "scripts", "seed-dataset.ts");
  const result = await runCommand(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      cwd: join(options.root, "agent"),
      echoPrefix: `[dream ${options.personId}]`,
      env: seedEnv(options),
      logFile: options.logFile,
    }
  );
  if (!succeeded(result)) {
    throw new Error(
      `Seeding ${options.personId} failed (exit ${result.code}). Log: ${options.logFile}`
    );
  }
}

/** Saves a finished Dream run into the cache. A failure is a warning, not an error. */
export function snapshotDream(options: {
  dataDir: string;
  dreamPrompt: string;
  key: DreamKey;
  manifestPath: string;
}): string | null {
  if (!evalCacheEnabled()) {
    return null;
  }
  try {
    return snapshotDreamRun({
      cacheDir: evalCacheDir(),
      dataDir: options.dataDir,
      dreamPrompt: options.dreamPrompt,
      key: options.key.key,
      manifestPath: options.manifestPath,
      parts: options.key.parts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Dream cache snapshot skipped: ${message}`);
    return null;
  }
}
