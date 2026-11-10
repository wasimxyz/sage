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
  cachedDreamEntry,
  computeCacheKey,
  dreamPromptsDir,
  evalCacheDir,
  evalCacheEnabled,
  loadCacheKeyParts,
  readDreamPrompts,
  restoreDreamCache,
  snapshotDreamCache,
  snapshotDreamRun,
} from "./cache.ts";

const sha256HexPattern = /^[a-f0-9]{64}$/u;
const missingPattern = /Missing/u;
const noFolderPattern = /No Dream prompt folder/u;

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
  writeFileSync(join(fixture.personDir, "01.md"), "edited\n");
  assert.notEqual(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey changes when a new entry file appears", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(join(fixture.personDir, "02.md"), "second entry\n");
  assert.notEqual(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey ignores case.yaml, so editing a test does not run Dream again", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(join(fixture.personDir, "case.yaml"), "id: sam-edited\n");
  assert.equal(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey changes when a past chat appears or changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  mkdirSync(join(fixture.personDir, "chats"));
  writeFileSync(
    join(fixture.personDir, "chats", "2026-07-01-first.md"),
    "User: hi\n"
  );
  const withChat = computeCacheKey(fixture.parts);
  assert.notEqual(withChat, before);
  writeFileSync(
    join(fixture.personDir, "chats", "2026-07-01-first.md"),
    "User: hello\n"
  );
  assert.notEqual(computeCacheKey(fixture.parts), withChat);
});

test("computeCacheKey ignores another person's files", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  const other = join(fixture.dataRoot, "people", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "01.md"), "someone else\n");
  assert.equal(computeCacheKey(fixture.parts), before);
  writeFileSync(join(other, "01.md"), "someone else, edited\n");
  assert.equal(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey differs per person", () => {
  const fixture = makeFixture();
  const other = join(fixture.dataRoot, "people", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "01.md"), "hello\n");
  assert.notEqual(
    computeCacheKey(fixture.parts),
    computeCacheKey({ ...fixture.parts, person: "other" })
  );
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

test("computeCacheKey changes with the memory flag", () => {
  const fixture = makeFixture();
  assert.notEqual(
    computeCacheKey(fixture.parts),
    computeCacheKey({ ...fixture.parts, memory: "on" })
  );
});

test("computeCacheKey follows the Dream prompt text, not its folder name", () => {
  const fixture = makeFixture();
  const builtin = computeCacheKey(fixture.parts);
  const variant = computeCacheKey({
    ...fixture.parts,
    dreamPrompts: { "summary.md": "Write a careful summary.\n" },
  });
  assert.notEqual(variant, builtin);
  const edited = computeCacheKey({
    ...fixture.parts,
    dreamPrompts: { "summary.md": "Write a careful, short summary.\n" },
  });
  assert.notEqual(edited, variant);
  const another = computeCacheKey({
    ...fixture.parts,
    dreamPrompts: { "extract.md": "Write a careful summary.\n" },
  });
  assert.notEqual(another, variant);
  const again = computeCacheKey({
    ...fixture.parts,
    dreamPrompts: { "summary.md": "Write a careful summary.\n" },
  });
  assert.equal(again, variant);
});

test("computeCacheKey changes when dream source changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(join(fixture.repoRoot, "src", "dream.zig"), "changed dream\n");
  assert.notEqual(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey changes when the schema changes", () => {
  const fixture = makeFixture();
  const before = computeCacheKey(fixture.parts);
  writeFileSync(
    join(fixture.repoRoot, "src", "schema", "0002.sql"),
    "CREATE TABLE u (id INTEGER);\n"
  );
  assert.notEqual(computeCacheKey(fixture.parts), before);
});

test("computeCacheKey throws for a person with no folder", () => {
  const fixture = makeFixture();
  assert.throws(
    () => computeCacheKey({ ...fixture.parts, person: "nobody" }),
    missingPattern
  );
});

test("readDreamPrompts is null for baseline and reads a variant's files", () => {
  const fixture = makeFixture();
  assert.equal(readDreamPrompts(fixture.repoRoot, "baseline"), null);
  const dir = dreamPromptsDir(fixture.repoRoot, "careful");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.md"), "Be careful.\n");
  writeFileSync(join(dir, "notes.txt"), "not a prompt file\n");
  assert.deepEqual(readDreamPrompts(fixture.repoRoot, "careful"), {
    "summary.md": "Be careful.\n",
  });
  assert.throws(
    () => readDreamPrompts(fixture.repoRoot, "missing"),
    noFolderPattern
  );
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

test("loadCacheKeyParts takes the run's settings and falls back to empty digests when lookup fails", async () => {
  const fixture = makeFixture();
  const previous = {
    data: process.env.SAGE_EVAL_DATA,
    repo: process.env.SAGE_REPO_ROOT,
  };
  process.env.SAGE_EVAL_DATA = fixture.dataRoot;
  process.env.SAGE_REPO_ROOT = fixture.repoRoot;
  try {
    const parts = await loadCacheKeyParts(
      {
        dreamPrompt: "baseline",
        embedModel: "nomic-embed-text",
        memory: "on",
        person: "sam",
        summaryModel: "qwen3:8b",
      },
      () => Promise.reject(new Error("offline"))
    );
    assert.equal(parts.summaryModel, "qwen3:8b");
    assert.equal(parts.embedModel, "nomic-embed-text");
    assert.equal(parts.summaryDigest, "");
    assert.equal(parts.embedDigest, "");
    assert.equal(parts.memory, "on");
    assert.equal(parts.person, "sam");
    assert.equal(parts.dreamPrompts, null);
    assert.equal(parts.dataRoot, fixture.dataRoot);
    assert.equal(parts.repoRoot, fixture.repoRoot);
  } finally {
    restoreEnv("SAGE_EVAL_DATA", previous.data);
    restoreEnv("SAGE_REPO_ROOT", previous.repo);
  }
});

test("loadCacheKeyParts records the digests the lookup finds", async () => {
  const fixture = makeFixture();
  const previous = {
    data: process.env.SAGE_EVAL_DATA,
    repo: process.env.SAGE_REPO_ROOT,
  };
  process.env.SAGE_EVAL_DATA = fixture.dataRoot;
  process.env.SAGE_REPO_ROOT = fixture.repoRoot;
  try {
    const parts = await loadCacheKeyParts(
      {
        dreamPrompt: "baseline",
        embedModel: "nomic-embed-text",
        memory: "off",
        person: "sam",
        summaryModel: "qwen3:8b",
      },
      () =>
        Promise.resolve({
          "nomic-embed-text": "sha256:embed",
          "qwen3:8b": "sha256:summary",
        })
    );
    assert.equal(parts.summaryDigest, "sha256:summary");
    assert.equal(parts.embedDigest, "sha256:embed");
  } finally {
    restoreEnv("SAGE_EVAL_DATA", previous.data);
    restoreEnv("SAGE_REPO_ROOT", previous.repo);
  }
});

test("snapshotDreamCache copies a checkpointed database into a key-named dir", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sage-eval-snap-data-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-eval-snap-cache-"));
  makeDatabase(dataDir);
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

test("snapshotDreamRun stamps the person, memory flag, and Dream prompt, and restoreDreamCache copies it back", () => {
  const fixture = makeFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "sage-eval-run-data-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "sage-eval-run-cache-"));
  makeDatabase(dataDir);
  const manifestPath = join(dataDir, "manifest.json");
  writeFileSync(manifestPath, '{"cases":{"sam":{"journalIds":[1]}}}\n');
  const key = computeCacheKey(fixture.parts);

  assert.equal(cachedDreamEntry(key, cacheDir), null);
  const dest = snapshotDreamRun({
    cacheDir,
    dataDir,
    dreamPrompt: "baseline",
    key,
    manifestPath,
    parts: fixture.parts,
  });
  assert.equal(cachedDreamEntry(key, cacheDir), dest);
  const stamp = JSON.parse(readFileSync(join(dest, "key.json"), "utf8")) as {
    dreamPrompt?: string;
    memory?: string;
    person?: string;
  };
  assert.equal(stamp.person, "sam");
  assert.equal(stamp.memory, "off");
  assert.equal(stamp.dreamPrompt, "baseline");

  const fresh = mkdtempSync(join(tmpdir(), "sage-eval-fresh-data-"));
  const freshManifest = join(fresh, "manifest.json");
  assert.equal(
    restoreDreamCache({
      cacheDir,
      dataDir: fresh,
      key: "not-a-key",
      manifestPath: freshManifest,
    }),
    false
  );
  assert.equal(
    restoreDreamCache({
      cacheDir,
      dataDir: fresh,
      key,
      manifestPath: freshManifest,
    }),
    true
  );
  assert.equal(existsSync(join(fresh, "app.db")), true);
  assert.equal(
    readFileSync(freshManifest, "utf8"),
    '{"cases":{"sam":{"journalIds":[1]}}}\n'
  );
});

function makeDatabase(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE memory (n INTEGER);");
  db.exec("INSERT INTO memory (n) VALUES (7);");
  db.close();
}

function makeFixture(): {
  dataRoot: string;
  parts: CacheKeyParts;
  personDir: string;
  repoRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sage-eval-cache-"));
  const repoRoot = join(root, "repo");
  const dataRoot = join(root, "data");
  const personDir = join(dataRoot, "people", "sam");
  mkdirSync(join(repoRoot, "src", "schema"), { recursive: true });
  mkdirSync(personDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "dream.zig"), "dream\n");
  writeFileSync(join(repoRoot, "src", "ollama.zig"), "ollama\n");
  writeFileSync(join(repoRoot, "src", "journal.zig"), "journal\n");
  writeFileSync(
    join(repoRoot, "src", "schema", "0001.sql"),
    "CREATE TABLE t (id INTEGER);\n"
  );
  writeFileSync(join(personDir, "01.md"), "hello\n");
  writeFileSync(join(personDir, "case.yaml"), "id: sam\n");
  return {
    dataRoot,
    parts: {
      dataRoot,
      dreamPrompts: null,
      embedDigest: "sha256:embed",
      embedModel: "nomic-embed-text",
      memory: "off",
      person: "sam",
      repoRoot,
      summaryDigest: "sha256:summary",
      summaryModel: "qwen3:8b",
    },
    personDir,
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
