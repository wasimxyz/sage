// Dream for one person: restore a cached snapshot, or seed the journal, let
// Dream run, and snapshot the result.
//
// The cache key is per person (see lib/cache.ts), so editing one person's
// entries runs Dream again for that person only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV_SEED_STAGE, type SeedStage } from "../../evals/lib/bridge.ts";
import {
  baselineDreamPrompt,
  type CacheKeyParts,
  cachedDreamEntry,
  computeCacheKey,
  dreamPromptFiles,
  dreamPromptsDir,
  evalCacheDir,
  evalCacheEnabled,
  fetchOllamaDigests,
  loadCacheKeyParts,
  repoRoot,
  restoreDreamCache,
  snapshotDreamRun,
} from "../../evals/lib/cache.ts";
import {
  chatIdFor,
  evalDataRoot,
  loadManifest,
} from "../../evals/lib/dataset.ts";
import type { Memory } from "../../evals/lib/schema.ts";
import type { ChatDay } from "./chat-times.ts";
import { withoutSageOnly } from "./env.ts";
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

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The size at which Sage stops reading a prompt file. `src/ollama.zig` reads
 * with `.limited(64 * 1024)`, and Zig's `readFileAlloc` fails when a file
 * reaches the limit, not only when it goes over.
 */
export const DREAM_PROMPT_FILE_LIMIT_BYTES = 64 * 1024;

/** Why Sage would keep its built-in prompt for a file, or null when it would use it. */
function promptFileProblem(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return "is not a file";
    }
    if (stats.size >= DREAM_PROMPT_FILE_LIMIT_BYTES) {
      return `is ${stats.size} bytes, and Sage reads only files under 64 KiB`;
    }
    return readFileSync(path, "utf8").trim().length === 0 ? "is empty" : null;
  } catch (error) {
    return `cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Problems with the Dream prompt folders a sweep names, one line each. Sage
 * keeps a built-in prompt for any file it cannot use and only logs it, so a
 * variant with a typo in a file name would run the built-in prompts for hours
 * and look like a real comparison. This catches that before anything starts.
 * `baseline` is not a folder. A name with no folder, a folder with none of the
 * four files, an unknown file, and a file that is empty, only whitespace, not
 * a regular file, or 64 KiB or more are problems.
 */
export function dreamPromptProblems(
  content: string,
  names: readonly string[]
): string[] {
  const problems: string[] = [];
  const files = dreamPromptFiles.join(", ");
  for (const name of names) {
    if (name === baselineDreamPrompt) {
      continue;
    }
    const dir = dreamPromptsDir(content, name);
    const where = `Dream prompt "${name}" (${dir})`;
    if (!isFolder(dir)) {
      const known = isFolder(dirname(dir))
        ? readdirSync(dirname(dir)).filter((entry) =>
            isFolder(join(dirname(dir), entry))
          )
        : [];
      problems.push(
        `${where} has no folder.${known.length > 0 ? ` Folders here: ${known.sort().join(", ")}.` : ""} Use ${baselineDreamPrompt} for the built-in prompts.`
      );
      continue;
    }
    const present = readdirSync(dir).filter((entry) => !entry.startsWith("."));
    const read = dreamPromptFiles.filter((file) => present.includes(file));
    const unknown = present.filter(
      (entry) => !(dreamPromptFiles as readonly string[]).includes(entry)
    );
    if (read.length === 0) {
      problems.push(
        `${where} holds none of ${files}, so it would run the built-in prompts. Use ${baselineDreamPrompt}, or add a file.`
      );
    }
    if (unknown.length > 0) {
      problems.push(
        `${where} holds ${unknown.sort().join(", ")}, which Dream does not read. The files it reads are ${files}.`
      );
    }
    for (const file of read) {
      const problem = promptFileProblem(join(dir, file));
      if (problem !== null) {
        problems.push(
          `${where}: ${file} ${problem}, so Dream keeps its built-in prompt for it.`
        );
      }
    }
  }
  return problems;
}

/** True when this person's journal has anything for Dream to read. */
export function needsDream(person: LoadedPerson): boolean {
  return person.entries.length > 0 || person.chats.length > 0;
}

/**
 * True when the seed step has to run in two stages: the person has past chats,
 * and Sage stamps those with the real clock. The runner stops Sage after the
 * first stage and rewrites the times to the chats' own days.
 */
export function seedsInStages(person: LoadedPerson): boolean {
  return person.chats.length > 0;
}

/**
 * The id Sage gave each seeded past chat, and the day it belongs on, read from
 * the manifest the first stage of the seed step wrote.
 */
export function seededChatDays(
  person: LoadedPerson,
  manifestPath: string
): ChatDay[] {
  const manifest = loadManifest(manifestPath);
  return person.chats.map((chat) => ({
    date: chat.date,
    id: chatIdFor(manifest, person.id, chat),
  }));
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
  stage?: SeedStage;
}): Record<string, string> {
  return {
    ...withoutSageOnly(),
    [ENV_SEED_STAGE]: options.stage ?? "all",
    SAGE_AUTOMATION_CWD: options.automationCwd,
    SAGE_DATA_DIR: options.dataDir,
    SAGE_EVAL_DATA: evalDataRoot(),
    SAGE_EVAL_MANIFEST: options.manifestPath,
    SAGE_EVAL_PERSON: options.personId,
    SAGE_REPO_ROOT: repoRoot(),
  };
}

export interface SeedOptions {
  automationCwd: string;
  dataDir: string;
  logFile: string;
  manifestPath: string;
  personId: string;
  root: string;
  /**
   * Which part of the seed step to run. `all`, the default, is for a person
   * with no past chats. A person with chats is seeded as `content`, then
   * `dream`, with the chat times rewritten between them.
   */
  stage?: SeedStage;
}

/** Seeds the person's journal through the bridge and waits for Dream. */
export async function seedPerson(options: SeedOptions): Promise<void> {
  const script = join(options.root, "agent", "scripts", "seed-dataset.ts");
  const stage = options.stage ?? "all";
  const result = await runCommand(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      cwd: join(options.root, "agent"),
      echoPrefix: `[${stage === "dream" ? "dream" : "seed"} ${options.personId}]`,
      env: seedEnv(options),
      logFile: options.logFile,
    }
  );
  if (!succeeded(result)) {
    throw new Error(
      `Seeding ${options.personId} (${stage}) failed (exit ${result.code}). Log: ${options.logFile}`
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
