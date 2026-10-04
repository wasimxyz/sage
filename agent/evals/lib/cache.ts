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

export interface CacheKeyParts {
  dataRoot: string;
  embedDigest: string;
  embedModel: string;
  repoRoot: string;
  summaryDigest: string;
  summaryModel: string;
}

export interface CacheStamp {
  createdAt: string;
  embedDigest: string;
  embedModel: string;
  key: string;
  summaryDigest: string;
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

export function evalCacheEntryDir(key: string, cacheDir = evalCacheDir()): string {
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
  hashDirectory(hash, parts.dataRoot, "data");
  hashListedFiles(hash, parts.repoRoot, dreamSourceFiles, "source");
  hashSchemaSql(hash, parts.repoRoot);
  return hash.digest("hex");
}

export async function loadCacheKeyParts(
  lookupDigests: (
    models: string[]
  ) => Promise<Partial<Record<string, string>>> = fetchOllamaDigests
): Promise<CacheKeyParts> {
  const summaryModel =
    process.env.SAGE_SUMMARY_MODEL !== undefined &&
    process.env.SAGE_SUMMARY_MODEL.length > 0
      ? process.env.SAGE_SUMMARY_MODEL
      : "qwen3.5:9b";
  const embedModel =
    process.env.SAGE_EMBED_MODEL !== undefined &&
    process.env.SAGE_EMBED_MODEL.length > 0
      ? process.env.SAGE_EMBED_MODEL
      : "nomic-embed-text";
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
  return {
    dataRoot: evalDataRoot(),
    embedDigest,
    embedModel,
    repoRoot: repoRoot(),
    summaryDigest,
    summaryModel,
  };
}

export async function fetchOllamaDigests(
  models: string[]
): Promise<Partial<Record<string, string>>> {
  const url = `${ollamaBaseURL().replace(/\/$/, "")}/tags`;
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
    rmSync(tmp, { recursive: true, force: true });
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

export async function snapshotDreamCacheFromEnv(
  key?: string
): Promise<string> {
  const parts = await loadCacheKeyParts();
  const resolvedKey =
    key !== undefined && key.length > 0 ? key : computeCacheKey(parts);
  return snapshotDreamCache({
    cacheDir: evalCacheDir(),
    dataDir: requireDataDir(),
    key: resolvedKey,
    manifestPath: process.env.SAGE_EVAL_MANIFEST,
    stamp: {
      createdAt: new Date().toISOString(),
      embedDigest: parts.embedDigest,
      embedModel: parts.embedModel,
      key: resolvedKey,
      summaryDigest: parts.summaryDigest,
      summaryModel: parts.summaryModel,
    },
  });
}

function hashDirectory(
  hash: ReturnType<typeof createHash>,
  root: string,
  label: string
): void {
  if (!existsSync(root)) {
    throw new Error(`Missing ${root}`);
  }
  const files = listFilesRecursive(root);
  hash.update(label);
  hash.update("\0");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
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
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < checkpointAttempts) {
          sleepSync(checkpointRetryMs);
        }
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

function requireDataDir(): string {
  const dir = process.env.SAGE_DATA_DIR;
  if (dir === undefined || dir.length === 0) {
    throw new Error("SAGE_DATA_DIR is not set.");
  }
  return dir;
}

function requireSqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
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
