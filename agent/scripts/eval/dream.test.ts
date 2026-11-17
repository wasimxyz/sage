import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  dreamKeyFor,
  needsDream,
  restoreSnapshot,
  seedEnv,
  snapshotDigests,
  snapshotDream,
} from "./dream.ts";
import { makePerson, tempDir } from "./test-fixtures.ts";

const pattern1 = /^[a-f0-9]{64}$/u;

const envNames = [
  "SAGE_EVAL_CACHE",
  "SAGE_EVAL_CACHE_DIR",
  "SAGE_EVAL_DATA",
  "SAGE_REPO_ROOT",
] as const;

/** Points the cache and the data root at temp folders for one test. */
function withTempRepo(t: test.TestContext): {
  cacheDir: string;
  dataRoot: string;
} {
  const root = tempDir(t);
  const repo = join(root, "repo");
  const dataRoot = join(root, "data");
  const cacheDir = join(root, "cache");
  mkdirSync(join(repo, "src", "schema"), { recursive: true });
  for (const file of ["dream.zig", "ollama.zig", "journal.zig"]) {
    writeFileSync(join(repo, "src", file), file);
  }
  writeFileSync(
    join(repo, "src", "schema", "0001.sql"),
    "CREATE TABLE t (id INTEGER);\n"
  );
  mkdirSync(join(dataRoot, "people", "sam"), { recursive: true });
  writeFileSync(join(dataRoot, "people", "sam", "2026-06-01-one.md"), "one\n");
  const previous = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]])
  );
  process.env.SAGE_EVAL_CACHE_DIR = cacheDir;
  process.env.SAGE_EVAL_DATA = dataRoot;
  process.env.SAGE_REPO_ROOT = repo;
  delete process.env.SAGE_EVAL_CACHE;
  t.after(() => {
    for (const name of envNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  });
  return { cacheDir, dataRoot };
}

const digests = () =>
  Promise.resolve({ "embed-m": "sha256:embed", "sum-m": "sha256:sum" });

function unitFor(memory: "off" | "on") {
  return {
    dreamPrompt: "baseline",
    embedModel: "embed-m",
    memory,
    person: makePerson("sam"),
    summaryModel: "sum-m",
  };
}

test("an empty journal has nothing for Dream", () => {
  assert.equal(needsDream(makePerson("sam")), true);
  assert.equal(needsDream(makePerson("kim", { entries: 0 })), false);
});

test("the Dream key follows the person's files and the memory flag", async (t) => {
  const { dataRoot } = withTempRepo(t);
  const first = await dreamKeyFor(unitFor("off"), digests);
  assert.match(first.key, pattern1);
  assert.equal(first.hit, false);
  assert.equal(first.parts.person, "sam");
  assert.equal((await dreamKeyFor(unitFor("off"), digests)).key, first.key);
  assert.notEqual((await dreamKeyFor(unitFor("on"), digests)).key, first.key);

  writeFileSync(join(dataRoot, "people", "sam", "case.yaml"), "id: sam\n");
  assert.equal(
    (await dreamKeyFor(unitFor("off"), digests)).key,
    first.key,
    "case.yaml is not in the key"
  );
  writeFileSync(join(dataRoot, "people", "sam", "2026-06-02-two.md"), "two\n");
  assert.notEqual((await dreamKeyFor(unitFor("off"), digests)).key, first.key);
});

test("a changed model digest changes the key", async (t) => {
  withTempRepo(t);
  const before = await dreamKeyFor(unitFor("off"), digests);
  const after = await dreamKeyFor(unitFor("off"), () =>
    Promise.resolve({ "embed-m": "sha256:embed", "sum-m": "sha256:other" })
  );
  assert.notEqual(after.key, before.key);
});

test("a snapshot is restored for the same key and misses for another", async (t) => {
  const { cacheDir } = withTempRepo(t);
  const dataDir = tempDir(t);
  const manifestPath = join(dataDir, "manifest.json");
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE memory (n INTEGER); INSERT INTO memory VALUES (7);"
  );
  db.close();
  writeFileSync(manifestPath, '{"cases":{"sam":{"journalIds":[1]}}}\n');

  const key = await dreamKeyFor(unitFor("off"), digests);
  const saved = snapshotDream({
    dataDir,
    dreamPrompt: "baseline",
    key,
    manifestPath,
  });
  assert.equal(saved, join(cacheDir, key.key));
  assert.equal((await dreamKeyFor(unitFor("off"), digests)).hit, true);

  const fresh = tempDir(t);
  assert.equal(
    restoreSnapshot({
      dataDir: fresh,
      key: "other",
      manifestPath: join(fresh, "manifest.json"),
    }),
    false
  );
  assert.equal(
    restoreSnapshot({
      dataDir: fresh,
      key: key.key,
      manifestPath: join(fresh, "manifest.json"),
    }),
    true
  );
  assert.equal(
    readFileSync(join(fresh, "manifest.json"), "utf8"),
    '{"cases":{"sam":{"journalIds":[1]}}}\n'
  );
});

test("SAGE_EVAL_CACHE=0 turns the cache off", async (t) => {
  withTempRepo(t);
  process.env.SAGE_EVAL_CACHE = "0";
  const dataDir = tempDir(t);
  const key = await dreamKeyFor(unitFor("off"), digests);
  assert.equal(key.hit, false);
  assert.equal(
    restoreSnapshot({
      dataDir,
      key: key.key,
      manifestPath: join(dataDir, "m.json"),
    }),
    false
  );
  assert.equal(
    snapshotDream({
      dataDir,
      dreamPrompt: "baseline",
      key,
      manifestPath: join(dataDir, "m.json"),
    }),
    null
  );
});

test("a failed snapshot is a warning, not an error", async (t) => {
  withTempRepo(t);
  const dataDir = tempDir(t);
  const key = await dreamKeyFor(unitFor("off"), digests);
  // No app.db in the folder.
  assert.equal(
    snapshotDream({
      dataDir,
      dreamPrompt: "baseline",
      key,
      manifestPath: join(dataDir, "m.json"),
    }),
    null
  );
});

test("snapshotDigests reads /api/tags once and answers from it", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        models: [{ digest: "sha256:aaa", name: "sum-m:latest" }],
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  const host = `127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const lookup = await snapshotDigests(["sum-m", "embed-m"], host);
  assert.deepEqual(await lookup(["sum-m", "embed-m"]), {
    "sum-m": "sha256:aaa",
  });
  assert.deepEqual(await lookup(["sum-m"]), { "sum-m": "sha256:aaa" });
  assert.equal(requests, 1);
});

test("snapshotDigests gives no digests when no server answers", async () => {
  const lookup = await snapshotDigests(["sum-m"], "127.0.0.1:1");
  assert.deepEqual(await lookup(["sum-m"]), {});
});

test("the seed script's environment names the person, the folder, and the manifest", (t) => {
  const { dataRoot } = withTempRepo(t);
  const env = seedEnv({
    automationCwd: "/tmp/sage-eval-x",
    dataDir: "/tmp/sage-eval-x",
    manifestPath: "/tmp/sage-eval-x/manifest.json",
    personId: "sam",
  });
  assert.equal(env.SAGE_EVAL_PERSON, "sam");
  assert.equal(env.SAGE_EVAL_MANIFEST, "/tmp/sage-eval-x/manifest.json");
  assert.equal(env.SAGE_AUTOMATION_CWD, "/tmp/sage-eval-x");
  assert.equal(env.SAGE_DATA_DIR, "/tmp/sage-eval-x");
  assert.equal(env.SAGE_EVAL_DATA, dataRoot);
});
