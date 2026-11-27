import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { evalDataRoot } from "./dataset.ts";
import { ollamaBaseURL } from "./models.ts";
import type { Memory } from "./schema.ts";

const trailingSlashPattern = /\/$/u;

const checkpointAttempts = 5;
const checkpointRetryMs = 200;

/**
 * Files whose contents affect Dream artifacts. Extend this list if dream
 * logic moves out of these paths.
 */
export const dreamSourceFiles = [
  "src/dream.zig",
  "src/ollama.zig",
  "src/journal.zig",
] as const;

/**
 * Files that decide what is seeded into the throwaway journal before Dream runs:
 * the seeding script, the bridge calls it makes, and the loader that reads each
 * entry. A change to any of them changes what Dream reads. The loader also reads
 * `case.yaml`, so a change to it runs Dream again even when only a check moved.
 */
export const seedSourceFiles = [
  "agent/scripts/seed-dataset.ts",
  "agent/scripts/automation.ts",
  "agent/evals/lib/dataset.ts",
] as const;

/** The files a Dream prompt folder can hold. A missing file keeps the built-in prompt. */
export const dreamPromptFiles = [
  "summary.md",
  "chat-summary.md",
  "chat-title.md",
  "extract.md",
] as const;

export const baselineDreamPrompt = "baseline";

/**
 * Everything that decides what a Dream snapshot holds. One snapshot is one
 * person, so `case.yaml` is not part of it: editing a test does not run Dream
 * again.
 */
export interface CacheKeyParts {
  dataRoot: string;
  /**
   * The text of each Dream prompt file the variant has, by file name. Null for
   * the built-in prompts, which are constants in the Dream source files hashed
   * below.
   */
  dreamPrompts: Record<string, string> | null;
  embedDigest: string;
  embedModel: string;
  memory: Memory;
  person: string;
  repoRoot: string;
  summaryDigest: string;
  summaryModel: string;
}

export interface CacheStamp {
  createdAt: string;
  dreamPrompt?: string;
  embedDigest: string;
  embedModel: string;
  key: string;
  memory?: Memory;
  person?: string;
  summaryDigest: string;
  summaryModel: string;
}

/** What `loadCacheKeyParts` needs to know about one Dream run. */
export interface CacheKeyInput {
  /** `baseline`, or the name of a folder under `agent/evals/dream-prompts/`. */
  dreamPrompt: string;
  embedModel: string;
  memory: Memory;
  person: string;
  summaryModel: string;
}

export interface SnapshotOptions {
  cacheDir: string;
  dataDir: string;
  key: string;
  manifestPath?: string;
  stamp?: CacheStamp | Record<string, unknown>;
}

export function evalCacheEnabled(): boolean {
  return process.env.SAGE_EVAL_CACHE !== "0";
}

export function repoRoot(): string {
  const fromEnv = process.env.SAGE_REPO_ROOT;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return fileURLToPath(new URL("../../..", import.meta.url));
}

export function evalCacheDir(): string {
  const fromEnv = process.env.SAGE_EVAL_CACHE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return join(repoRoot(), "agent", "evals", ".cache", "dream");
}

export function evalCacheEntryDir(
  key: string,
  cacheDir = evalCacheDir()
): string {
  return join(cacheDir, key);
}

export function computeCacheKey(parts: CacheKeyParts): string {
  const hash = createHash("sha256");
  hash.update("summary");
  hash.update("\0");
  hash.update(parts.summaryModel);
  hash.update("\0");
  hash.update(parts.summaryDigest);
  hash.update("\0");
  hash.update("embed");
  hash.update("\0");
  hash.update(parts.embedModel);
  hash.update("\0");
  hash.update(parts.embedDigest);
  hash.update("\0");
  hash.update("memory");
  hash.update("\0");
  hash.update(parts.memory);
  hash.update("\0");
  hashDreamPrompts(hash, parts.dreamPrompts);
  hashPerson(hash, join(parts.dataRoot, "people", parts.person), parts.person);
  hashListedFiles(hash, parts.repoRoot, dreamSourceFiles, "source");
  hashListedFiles(hash, parts.repoRoot, seedSourceFiles, "seed");
  hashSchemaSql(hash, parts.repoRoot);
  return hash.digest("hex");
}

/** `agent/evals/dream-prompts/<name>/` */
export function dreamPromptsDir(repo: string, name: string): string {
  return join(repo, "agent", "evals", "dream-prompts", name);
}

/**
 * The text of the Dream prompt files a variant has. Null for `baseline`, the
 * built-in prompts. Throws when a named variant has no folder.
 */
export function readDreamPrompts(
  repo: string,
  name: string
): Record<string, string> | null {
  if (name === baselineDreamPrompt) {
    return null;
  }
  const dir = dreamPromptsDir(repo, name);
  if (!(existsSync(dir) && statSync(dir).isDirectory())) {
    throw new Error(`No Dream prompt folder at ${dir}.`);
  }
  const texts: Record<string, string> = {};
  for (const file of dreamPromptFiles) {
    const path = join(dir, file);
    if (existsSync(path)) {
      texts[file] = readFileSync(path, "utf8");
    }
  }
  return texts;
}

export async function loadCacheKeyParts(
  input: CacheKeyInput,
  lookupDigests: (
    models: string[]
  ) => Promise<Partial<Record<string, string>>> = fetchOllamaDigests
): Promise<CacheKeyParts> {
  const { embedModel, summaryModel } = input;
  let summaryDigest = "";
  let embedDigest = "";
  try {
    const digests = await lookupDigests([summaryModel, embedModel]);
    summaryDigest = digests[summaryModel] ?? "";
    embedDigest = digests[embedModel] ?? "";
  } catch {
    console.warn(
      "Could not read Ollama model digests; cache key uses model names only."
    );
  }
  const repo = repoRoot();
  return {
    dataRoot: evalDataRoot(),
    dreamPrompts: readDreamPrompts(repo, input.dreamPrompt),
    embedDigest,
    embedModel,
    memory: input.memory,
    person: input.person,
    repoRoot: repo,
    summaryDigest,
    summaryModel,
  };
}

export async function fetchOllamaDigests(
  models: string[],
  baseURL: string = ollamaBaseURL()
): Promise<Partial<Record<string, string>>> {
  const url = `${baseURL.replace(trailingSlashPattern, "")}/tags`;
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) {
    throw new Error(`Ollama tags returned HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  const rows = ollamaTagRows(payload);
  const digests: Partial<Record<string, string>> = {};
  for (const name of models) {
    const digest = digestFromTags(rows, name);
    if (digest.length > 0) {
      digests[name] = digest;
    }
  }
  return digests;
}

export function snapshotDreamCache(options: SnapshotOptions): string {
  const dest = evalCacheEntryDir(options.key, options.cacheDir);
  if (
    existsSync(join(dest, "app.db")) &&
    existsSync(join(dest, "manifest.json"))
  ) {
    return dest;
  }
  const dbPath = join(options.dataDir, "app.db");
  const manifestPath =
    options.manifestPath !== undefined && options.manifestPath.length > 0
      ? options.manifestPath
      : join(options.dataDir, "manifest.json");
  if (!existsSync(dbPath)) {
    throw new Error(`Missing ${dbPath}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}`);
  }
  checkpointWal(dbPath);
  mkdirSync(options.cacheDir, { recursive: true });
  const tmp = join(
    options.cacheDir,
    `tmp-${process.pid}-${Date.now().toString()}`
  );
  mkdirSync(tmp, { recursive: true });
  try {
    copyFileSync(dbPath, join(tmp, "app.db"));
    copyFileSync(manifestPath, join(tmp, "manifest.json"));
    const stamp = options.stamp ?? {
      createdAt: new Date().toISOString(),
      key: options.key,
    };
    writeFileSync(join(tmp, "key.json"), `${JSON.stringify(stamp, null, 2)}\n`);
    renameSync(tmp, dest);
  } catch (error) {
    rmSync(tmp, { force: true, recursive: true });
    if (
      existsSync(join(dest, "app.db")) &&
      existsSync(join(dest, "manifest.json"))
    ) {
      return dest;
    }
    throw error;
  }
  return dest;
}

/** The cache entry for a key, or null when there is none. */
export function cachedDreamEntry(
  key: string,
  cacheDir = evalCacheDir()
): string | null {
  const dir = evalCacheEntryDir(key, cacheDir);
  return existsSync(join(dir, "app.db")) &&
    existsSync(join(dir, "manifest.json"))
    ? dir
    : null;
}

/**
 * Copies a snapshot's database and manifest into a data directory. Returns
 * false on a miss. Run it before Sage starts, so Sage opens the restored file.
 */
export function restoreDreamCache(options: {
  cacheDir?: string;
  dataDir: string;
  key: string;
  manifestPath: string;
}): boolean {
  const dir = cachedDreamEntry(options.key, options.cacheDir);
  if (dir === null) {
    return false;
  }
  copyFileSync(join(dir, "app.db"), join(options.dataDir, "app.db"));
  copyFileSync(join(dir, "manifest.json"), options.manifestPath);
  return true;
}

/** Snapshots a finished Dream run into the cache, with a stamp of what made it. */
export function snapshotDreamRun(options: {
  cacheDir?: string;
  dataDir: string;
  dreamPrompt: string;
  key: string;
  manifestPath: string;
  parts: CacheKeyParts;
}): string {
  const { parts } = options;
  return snapshotDreamCache({
    cacheDir: options.cacheDir ?? evalCacheDir(),
    dataDir: options.dataDir,
    key: options.key,
    manifestPath: options.manifestPath,
    stamp: {
      createdAt: new Date().toISOString(),
      dreamPrompt: options.dreamPrompt,
      embedDigest: parts.embedDigest,
      embedModel: parts.embedModel,
      key: options.key,
      memory: parts.memory,
      person: parts.person,
      summaryDigest: parts.summaryDigest,
      summaryModel: parts.summaryModel,
    },
  });
}

function hashDreamPrompts(
  hash: ReturnType<typeof createHash>,
  prompts: Record<string, string> | null
): void {
  hash.update("dream-prompts");
  hash.update("\0");
  if (prompts === null) {
    // The built-in prompts are constants in src/ollama.zig, and the source
    // hash below covers that file.
    hash.update("builtin");
    hash.update("\0");
    return;
  }
  for (const file of Object.keys(prompts).sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(prompts[file] ?? "");
    hash.update("\0");
  }
}

/**
 * One person's entries (the `.md` files beside `case.yaml`) and past chats
 * (`chats/`). `case.yaml` stays out, so editing a test does not run Dream
 * again.
 */
function hashPerson(
  hash: ReturnType<typeof createHash>,
  dir: string,
  person: string
): void {
  if (!existsSync(dir)) {
    throw new Error(`Missing ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort()
    .filter((name) => statSync(join(dir, name)).isFile());
  const chatsDir = join(dir, "chats");
  if (existsSync(chatsDir) && statSync(chatsDir).isDirectory()) {
    for (const rel of listFilesRecursive(chatsDir)) {
      files.push(`chats/${rel}`);
    }
  }
  hash.update("person");
  hash.update("\0");
  hash.update(person);
  hash.update("\0");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
}

function hashListedFiles(
  hash: ReturnType<typeof createHash>,
  repo: string,
  relPaths: readonly string[],
  label: string
): void {
  hash.update(label);
  hash.update("\0");
  for (const rel of relPaths) {
    const path = join(repo, rel);
    if (!existsSync(path)) {
      throw new Error(`Missing ${path}`);
    }
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
}

function hashSchemaSql(
  hash: ReturnType<typeof createHash>,
  repo: string
): void {
  const dir = join(repo, "src", "schema");
  if (!existsSync(dir)) {
    throw new Error(`Missing ${dir}`);
  }
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !name.startsWith("."))
    .sort();
  hash.update("schema");
  hash.update("\0");
  for (const name of names) {
    const rel = `src/schema/${name}`;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
    hash.update("\0");
  }
}

function listFilesRecursive(root: string): string[] {
  const files: string[] = [];
  walk(root, "", files);
  files.sort();
  return files;
}

function walk(dir: string, rel: string, files: string[]): void {
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    const childRel = rel.length === 0 ? name : `${rel}/${name}`;
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, childRel, files);
    } else if (info.isFile()) {
      files.push(childRel);
    }
  }
}

function checkpointWal(dbPath: string): void {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < checkpointAttempts; attempt += 1) {
      try {
        // A checkpoint that cannot finish does not throw. It answers with a
        // row whose `busy` column is 1, and the log then still holds changes
        // that a copy of app.db alone would miss.
        const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get() as
          | { busy?: number | bigint }
          | undefined;
        if (Number(row?.busy ?? 0) === 0) {
          return;
        }
        lastError = new Error(
          "WAL checkpoint could not finish because the database is busy."
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < checkpointAttempts) {
        sleepSync(checkpointRetryMs);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("WAL checkpoint failed.");
  } finally {
    db.close();
  }
}

function sleepSync(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)]);
}

function requireSqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)(
    "node:sqlite"
  ) as typeof import("node:sqlite");
}

interface OllamaTagRow {
  digest?: string;
  model?: string;
  name?: string;
}

function ollamaTagRows(payload: unknown): OllamaTagRow[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("models" in payload) ||
    !Array.isArray((payload as { models: unknown }).models)
  ) {
    return [];
  }
  const rows: OllamaTagRow[] = [];
  for (const item of (payload as { models: unknown[] }).models) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    rows.push({
      digest: typeof row.digest === "string" ? row.digest : undefined,
      model: typeof row.model === "string" ? row.model : undefined,
      name: typeof row.name === "string" ? row.name : undefined,
    });
  }
  return rows;
}

function digestFromTags(rows: OllamaTagRow[], wanted: string): string {
  const aliases = new Set<string>([wanted]);
  if (wanted.endsWith(":latest")) {
    aliases.add(wanted.slice(0, -":latest".length));
  } else {
    aliases.add(`${wanted}:latest`);
  }
  for (const row of rows) {
    const names = [row.name, row.model].filter(
      (name): name is string => name !== undefined
    );
    if (
      names.some((name) => aliases.has(name)) &&
      row.digest !== undefined &&
      row.digest.length > 0
    ) {
      return row.digest;
    }
  }
  return "";
}
