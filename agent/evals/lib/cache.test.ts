import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  type CacheKeyParts,
  computeCacheKey,
  evalCacheDir,
  evalCacheEnabled,
  loadCacheKeyParts,
  snapshotDreamCache,
} from "./cache.ts";

const sha256HexPattern = /^[a-f0-9]{64}$/;

test("computeCacheKey is stable for fixed inputs", () => {
  const fixture = makeFixture();
  const first = computeCacheKey(fixture.parts);
  const second = computeCacheKey(fixture.parts);
  assert.equal(first, second);
  assert.match(first, sha256HexPattern);
});

test("computeCacheKey changes when an entry body changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(
    join(fixture.dataRoot, "timelines", "sam", "01.md"),
    "edited\n"
  );
  const after = computeCacheKey(fixture.parts);
  assert.notEqual(after, before);
});

test("computeCacheKey changes when a new entry file appears", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(
    join(fixture.dataRoot, "timelines", "sam", "02.md"),
    "second entry\n"
  );
  const after = computeCacheKey(fixture.parts);
  assert.notEqual(after, before);
});

test("computeCacheKey changes when case.yaml changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(
    join(fixture.dataRoot, "timelines", "sam", "case.yaml"),
    "id: sam-edited\n"
  );
  const after = computeCacheKey(fixture.parts);
  assert.notEqual(after, before);
});

test("computeCacheKey changes when the model name changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  const after = computeCacheKey({
    ...fixture.parts,
    summaryModel: "qwen3:14b",
  });
  assert.notEqual(after, before);
});

test("computeCacheKey changes when a model digest changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  const after = computeCacheKey({
    ...fixture.parts,
    embedDigest: "sha256:changed",
  });
  assert.notEqual(after, before);
});

test("computeCacheKey changes when dream source changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(join(fixture.repoRoot, "src", "dream.zig"), "changed dream\n");
  const after = computeCacheKey(fixture.parts);
  assert.notEqual(after, before);
});

test("evalCacheEnabled is false only when SAGE_EVAL_CACHE is 0", () => {
  const previous = process.env.SAGE_EVAL_CACHE;
  try {
    process.env.SAGE_EVAL_CACHE = "";
    assert.equal(evalCacheEnabled(), true);
    process.env.SAGE_EVAL_CACHE = "1";
    assert.equal(evalCacheEnabled(), true);
    process.env.SAGE_EVAL_CACHE = "0";
    assert.equal(evalCacheEnabled(), false);
  } finally {
    restoreEnv("SAGE_EVAL_CACHE", previous);
  }
});

test("evalCacheDir prefers SAGE_EVAL_CACHE_DIR", () => {
  const previous = process.env.SAGE_EVAL_CACHE_DIR;
  process.env.SAGE_EVAL_CACHE_DIR = "/tmp/sage-eval-cache";
  try {
    assert.equal(evalCacheDir(), "/tmp/sage-eval-cache");
  } finally {
    restoreEnv("SAGE_EVAL_CACHE_DIR", previous);
  }
});

test("loadCacheKeyParts falls back to empty digests when lookup fails", async () => {
  const fixture = makeFixture();
  const previous = {
    data: process.env.SAGE_EVAL_DATA,
    embed: process.env.SAGE_EMBED_MODEL,
    repo: process.env.SAGE_REPO_ROOT,
    summary: process.env.SAGE_SUMMARY_MODEL,
  };
  process.env.SAGE_EVAL_DATA = fixture.dataRoot;
  process.env.SAGE_REPO_ROOT = fixture.repoRoot;
  process.env.SAGE_SUMMARY_MODEL = "qwen3:8b";
  process.env.SAGE_EMBED_MODEL = "nomic-embed-text";
  try {
    const parts = await loadCacheKeyParts(() =>
      Promise.reject(new Error("offline"))
    );
    assert.equal(parts.summaryModel, "qwen3:8b");
    assert.equal(parts.embedModel, "nomic-embed-text");
    assert.equal(parts.summaryDigest, "");
    assert.equal(parts.embedDigest, "");
    assert.equal(parts.dataRoot, fixture.dataRoot);
    assert.equal(parts.repoRoot, fixture.repoRoot);
  } finally {
    restoreEnv("SAGE_EVAL_DATA", previous.data);
    restoreEnv("SAGE_REPO_ROOT", previous.repo);
    restoreEnv("SAGE_SUMMARY_MODEL", previous.summary);
    restoreEnv("SAGE_EMBED_MODEL", previous.embed);
  }
});

test("snapshotDreamCache copies a checkpointed database into a key-named dir", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sage-eval-snap-data-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-eval-snap-cache-"));
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE memory (n INTEGER);");
  db.exec("INSERT INTO memory (n) VALUES (7);");
  db.close();
  writeFileSync(join(dataDir, "manifest.json"), '{"cases":{}}\n');

  const dest = snapshotDreamCache({
    cacheDir,
    dataDir,
    key: "abc123",
    stamp: {
      createdAt: "2026-09-15T00:00:00.000Z",
      embedDigest: "",
      embedModel: "nomic-embed-text",
      key: "abc123",
      summaryDigest: "",
      summaryModel: "qwen3:8b",
    },
  });

  assert.equal(dest, join(cacheDir, "abc123"));
  assert.equal(existsSync(join(dest, "app.db")), true);
  assert.equal(existsSync(join(dest, "manifest.json")), true);
  assert.equal(existsSync(join(dest, "key.json")), true);
  assert.equal(
    readFileSync(join(dest, "manifest.json"), "utf8"),
    '{"cases":{}}\n'
  );
  const stamp = JSON.parse(readFileSync(join(dest, "key.json"), "utf8")) as {
    key?: string;
  };
  assert.equal(stamp.key, "abc123");

  const copied = new DatabaseSync(join(dest, "app.db"), { readOnly: true });
  try {
    const row = copied.prepare("SELECT n FROM memory").get() as
      | { n?: unknown }
      | undefined;
    assert.equal(row?.n, 7);
  } finally {
    copied.close();
  }
});

function makeFixture(): {
  dataRoot: string;
  parts: CacheKeyParts;
  repoRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sage-eval-cache-"));
  const repoRoot = join(root, "repo");
  const dataRoot = join(root, "data");
  mkdirSync(join(repoRoot, "src", "schema"), { recursive: true });
  mkdirSync(join(dataRoot, "timelines", "sam"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "dream.zig"), "dream\n");
  writeFileSync(join(repoRoot, "src", "ollama.zig"), "ollama\n");
  writeFileSync(join(repoRoot, "src", "journal.zig"), "journal\n");
  writeFileSync(
    join(repoRoot, "src", "schema", "0001.sql"),
    "CREATE TABLE t (id INTEGER);\n"
  );
  writeFileSync(join(dataRoot, "timelines", "sam", "01.md"), "hello\n");
  writeFileSync(join(dataRoot, "timelines", "sam", "case.yaml"), "id: sam\n");
  return {
    dataRoot,
    parts: {
      dataRoot,
      embedDigest: "sha256:embed",
      embedModel: "nomic-embed-text",
      repoRoot,
      summaryDigest: "sha256:summary",
      summaryModel: "qwen3:8b",
    },
    repoRoot,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
