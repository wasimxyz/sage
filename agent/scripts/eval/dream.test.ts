import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  dreamKeyFor,
  dreamPromptProblems,
  needsDream,
  restoreSnapshot,
  seedEnv,
  seededChatDays,
  seedsInStages,
  snapshotDigests,
  snapshotDream,
} from "./dream.ts";
import { makePerson, tempDir, writeCacheKeyFiles } from "./test-fixtures.ts";

const pattern2 = /no chat id for past chat 3/u;

const pattern1 = /^[a-f0-9]{64}$/u;
const noFolderPattern =
  /Dream prompt "typo" .* has no folder\. Folders here: careful, terse\. Use baseline/u;
const noFilesPattern =
  /holds none of summary\.md, chat-summary\.md, chat-title\.md, extract\.md/u;
const unknownFilePattern =
  /"misnamed" .* holds Summary\.md, notes\.txt, which Dream does not read/u;
const emptyFilePattern = /"blank" .*: extract\.md is empty/u;
const bigFilePattern =
  /"(?:big|huge)" .*: summary\.md is 6\d{4} bytes, and Sage reads only files under 64 KiB/u;
const notAFilePattern = /"folder" .*: summary\.md is not a file/u;
const noPromptFolderPattern =
  /No Dream prompt folder at .*dream-prompts\/nope/u;

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
  writeCacheKeyFiles(repo);
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

function unitFor(memory: "off" | "on", dreamPrompt = "baseline") {
  return {
    dreamPrompt,
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

test("a past chat is part of the Dream key, and editing one runs Dream again", async (t) => {
  const { dataRoot } = withTempRepo(t);
  const before = await dreamKeyFor(unitFor("off"), digests);
  const chats = join(dataRoot, "people", "sam", "chats");
  mkdirSync(chats, { recursive: true });
  const file = join(chats, "2026-07-01-first.md");
  writeFileSync(
    file,
    "---\ndate: 2026-07-01\ntitle: First\n---\nUser: hi\nSage: hello\n"
  );
  const added = await dreamKeyFor(unitFor("off"), digests);
  assert.notEqual(added.key, before.key, "a new chat");
  writeFileSync(
    file,
    "---\ndate: 2026-07-02\ntitle: First\n---\nUser: hi\nSage: hello\n"
  );
  const edited = await dreamKeyFor(unitFor("off"), digests);
  assert.notEqual(edited.key, added.key, "a changed date");
  writeFileSync(
    join(chats, "2026-07-09-second.md"),
    "---\ndate: 2026-07-09\ntitle: Second\n---\nUser: a\nSage: b\n"
  );
  assert.notEqual((await dreamKeyFor(unitFor("off"), digests)).key, edited.key);
});

test("a person with chats and no entries still needs Dream, and one with past chats is seeded in stages", () => {
  const chat = {
    date: "2026-09-12",
    fileName: "2026-09-12-a.md",
    index: 1,
    stem: "2026-09-12-a",
    title: "A",
    turns: [
      { role: "user" as const, text: "Hi." },
      { role: "assistant" as const, text: "Hello." },
    ],
    wordCount: 2,
  };
  const chatty = makePerson("kim", { chats: [chat], entries: 0 });
  assert.equal(needsDream(chatty), true);
  assert.equal(seedsInStages(chatty), true);
  assert.equal(seedsInStages(makePerson("sam")), false);
  assert.equal(seedsInStages(makePerson("kim", { entries: 0 })), false);
});

test("seededChatDays pairs each past chat's id from the manifest with its day", (t) => {
  const dir = tempDir(t);
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    '{"cases":{"sam":{"chatIds":[31,32],"journalIds":[1]}}}\n'
  );
  const turns = [
    { role: "user" as const, text: "Hi." },
    { role: "assistant" as const, text: "Hello." },
  ];
  const chat = (index: number, date: string) => ({
    date,
    fileName: `${date}-c${index}.md`,
    index,
    stem: `${date}-c${index}`,
    title: `C${index}`,
    turns,
    wordCount: 2,
  });
  const person = makePerson("sam", {
    chats: [chat(1, "2026-09-12"), chat(2, "2026-10-24")],
  });
  assert.deepEqual(seededChatDays(person, manifestPath), [
    { date: "2026-09-12", id: 31 },
    { date: "2026-10-24", id: 32 },
  ]);
  const short = makePerson("sam", {
    chats: [
      chat(1, "2026-09-12"),
      chat(2, "2026-10-24"),
      chat(3, "2026-11-01"),
    ],
  });
  assert.throws(() => seededChatDays(short, manifestPath), pattern2);
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
  assert.equal(
    env.SAGE_EVAL_SEED_STAGE,
    "all",
    "one go unless a stage is named"
  );
});

test("the seed script's environment carries the stage a person with past chats is seeded in", () => {
  for (const stage of ["content", "dream"] as const) {
    const env = seedEnv({
      automationCwd: "/tmp/sage-eval-x",
      dataDir: "/tmp/sage-eval-x",
      manifestPath: "/tmp/sage-eval-x/manifest.json",
      personId: "sam",
      stage,
    });
    assert.equal(env.SAGE_EVAL_SEED_STAGE, stage);
  }
});

test("the seed script's environment never carries the Dream prompt folder", (t) => {
  withTempRepo(t);
  const previous = process.env.SAGE_EVAL_DREAM_PROMPTS;
  process.env.SAGE_EVAL_DREAM_PROMPTS = "/stray/prompts";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.SAGE_EVAL_DREAM_PROMPTS;
    } else {
      process.env.SAGE_EVAL_DREAM_PROMPTS = previous;
    }
  });
  const env = seedEnv({
    automationCwd: "/tmp/sage-eval-x",
    dataDir: "/tmp/sage-eval-x",
    manifestPath: "/tmp/sage-eval-x/manifest.json",
    personId: "sam",
  });
  assert.equal(env.SAGE_EVAL_DREAM_PROMPTS, undefined);
});

/** Writes prompt files under `agent/evals/dream-prompts/<name>/` of the temp repo. */
function writePrompts(
  repo: string,
  name: string,
  files: Record<string, string>
): void {
  const dir = join(repo, "agent", "evals", "dream-prompts", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dir, file), text);
  }
}

/** The temp repo `withTempRepo` made. */
function repoOf(): string {
  return process.env.SAGE_REPO_ROOT ?? "";
}

test("the Dream key includes the text of the resolved prompt files", async (t) => {
  withTempRepo(t);
  const repo = repoOf();
  writePrompts(repo, "careful", { "summary.md": "Summarize with care." });
  writePrompts(repo, "same", { "summary.md": "Summarize with care." });
  writePrompts(repo, "terse", { "summary.md": "Summarize tersely." });
  const baseline = await dreamKeyFor(unitFor("off"), digests);
  const careful = await dreamKeyFor(unitFor("off", "careful"), digests);
  assert.notEqual(careful.key, baseline.key);
  assert.deepEqual(careful.parts.dreamPrompts, {
    "summary.md": "Summarize with care.",
  });
  assert.equal(baseline.parts.dreamPrompts, null);

  // The key follows the text, not the folder's name.
  assert.equal(
    (await dreamKeyFor(unitFor("off", "same"), digests)).key,
    careful.key
  );
  assert.notEqual(
    (await dreamKeyFor(unitFor("off", "terse"), digests)).key,
    careful.key
  );

  // Editing a file, or adding another, runs Dream again.
  writePrompts(repo, "careful", { "summary.md": "Summarize with great care." });
  const edited = await dreamKeyFor(unitFor("off", "careful"), digests);
  assert.notEqual(edited.key, careful.key);
  writePrompts(repo, "careful", { "extract.md": "Extract only what is said." });
  assert.notEqual(
    (await dreamKeyFor(unitFor("off", "careful"), digests)).key,
    edited.key
  );
});

test("a Dream prompt with no folder cannot make a key", async (t) => {
  withTempRepo(t);
  await assert.rejects(
    dreamKeyFor(unitFor("off", "nope"), digests),
    noPromptFolderPattern
  );
});

test("dreamPromptProblems accepts baseline and folders with real prompt files", (t) => {
  withTempRepo(t);
  const repo = repoOf();
  writePrompts(repo, "careful", {
    ".DS_Store": "",
    "chat-title.md": "Title it.",
    "summary.md": "Summarize.",
  });
  assert.deepEqual(dreamPromptProblems(repo, ["baseline", "careful"]), []);
});

test("dreamPromptProblems names a missing folder and the folders that exist", (t) => {
  withTempRepo(t);
  const repo = repoOf();
  writePrompts(repo, "careful", { "summary.md": "Summarize." });
  writePrompts(repo, "terse", { "summary.md": "Tersely." });
  const [problem, ...rest] = dreamPromptProblems(repo, ["typo"]);
  assert.match(problem ?? "", noFolderPattern);
  assert.deepEqual(rest, []);
});

test("dreamPromptProblems catches a variant that would quietly run the built-in prompts", (t) => {
  withTempRepo(t);
  const repo = repoOf();
  writePrompts(repo, "empty", {});
  writePrompts(repo, "misnamed", {
    "notes.txt": "x",
    "Summary.md": "Summarize.",
  });
  writePrompts(repo, "blank", {
    "extract.md": "  \n",
    "summary.md": "Summarize.",
  });
  assert.match(dreamPromptProblems(repo, ["empty"]).join("\n"), noFilesPattern);
  const misnamed = dreamPromptProblems(repo, ["misnamed"]).join("\n");
  assert.match(misnamed, unknownFilePattern);
  assert.match(misnamed, noFilesPattern);
  assert.match(
    dreamPromptProblems(repo, ["blank"]).join("\n"),
    emptyFilePattern
  );
});

test("dreamPromptProblems rejects a prompt file of 64 KiB or more, which Sage will not read", (t) => {
  withTempRepo(t);
  const repo = repoOf();
  // src/ollama.zig reads with `.limited(64 * 1024)`, and Zig's readFileAlloc
  // fails when a file reaches the limit. Sage then keeps the built-in prompt.
  writePrompts(repo, "big", { "summary.md": "x".repeat(64 * 1024) });
  writePrompts(repo, "huge", { "summary.md": "x".repeat(64 * 1024 + 1) });
  writePrompts(repo, "fits", { "summary.md": "x".repeat(64 * 1024 - 1) });
  const big = dreamPromptProblems(repo, ["big"]).join("\n");
  assert.match(big, bigFilePattern);
  assert.match(dreamPromptProblems(repo, ["huge"]).join("\n"), bigFilePattern);
  assert.deepEqual(dreamPromptProblems(repo, ["fits"]), []);
});

test("dreamPromptProblems reports a prompt file that is a folder, and does not throw", (t) => {
  withTempRepo(t);
  const repo = repoOf();
  writePrompts(repo, "folder", { "extract.md": "Extract less." });
  mkdirSync(
    join(repo, "agent", "evals", "dream-prompts", "folder", "summary.md")
  );
  let problems: string[] = [];
  assert.doesNotThrow(() => {
    problems = dreamPromptProblems(repo, ["folder"]);
  });
  assert.equal(problems.length, 1);
  assert.match(problems.join("\n"), notAFilePattern);
});
