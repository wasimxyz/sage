// A launch with SAGE_DATA_DIR must open exactly one app.db, in that directory.
// `make eval` keeps the real $HOME, so a data dir resolved a second time inside
// the runner is the packaged journal path under the real home folder.
//
// The runtime proof lives in the eval run itself: start the built binary with
// SAGE_DATA_DIR at a throwaway folder and check that app.db lands there. These
// checks catch the regression without a build.

import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  prepareDataDir,
  removeBuilds,
  sageEnv,
} from "../agent/scripts/eval/sage.ts";
import { seedEnv } from "../agent/scripts/eval/dream.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");

test("the eval Sage opens the throwaway data dir, whatever the shell says", () => {
  const dataDir = prepareDataDir(repoRoot);
  const env = sageEnv({
    base: {
      HOME: "/Users/someone",
      NATIVE_SDK_MODE: "dev",
      PATH: "/usr/bin",
      SAGE_DATA_DIR: "/Users/someone/Library/Application Support/com.wasimxyz.sage",
      SAGE_DEV_EVE_WORKFLOW_DIR: "/Users/someone/sage/agent/.eve",
    },
    dataDir,
    embedModel: "nomic-embed-text",
    ollamaBin: "/opt/ollama",
    summaryModel: "qwen3.5:9b",
  });
  assert.equal(env.SAGE_DATA_DIR, dataDir);
  assert.equal(env.NATIVE_SDK_MODE, undefined, "no dev mode, so Sage picks the dev port");
  assert.equal(env.SAGE_DEV_EVE_WORKFLOW_DIR, undefined);
  assert.equal(env.SAGE_OLLAMA_PATH, "/opt/ollama");
  assert.equal(env.HOME, "/Users/someone", "HOME is left alone; SAGE_DATA_DIR is what decides the folder");
});

test("the data dir is a fresh folder under the temp dir, with the stub frontend and app.json", () => {
  const dataDir = prepareDataDir(repoRoot);
  assert.ok(realpathSync(dataDir).startsWith(realpathSync(tmpdir())));
  assert.ok(existsSync(join(dataDir, "frontend", "dist", "index.html")));
  assert.ok(lstatSync(join(dataDir, "app.json")).isSymbolicLink());
  assert.ok(!existsSync(join(dataDir, "app.db")), "a new journal, not a copy of one");
  removeBuilds(join(dataDir, "none"));
});

test("the seed script drives the same throwaway folder", () => {
  const env = seedEnv({
    automationCwd: "/tmp/sage-eval-x",
    dataDir: "/tmp/sage-eval-x",
    manifestPath: "/tmp/sage-eval-x/manifest.json",
    personId: "sam-example",
  });
  assert.equal(env.SAGE_DATA_DIR, "/tmp/sage-eval-x");
  assert.equal(env.SAGE_AUTOMATION_CWD, "/tmp/sage-eval-x");
});

test("the runner starts Sage with the environment it builds, and nothing else", () => {
  const sage = read("agent/scripts/eval/sage.ts");
  assert.ok(sage.includes("env.SAGE_DATA_DIR = options.dataDir"));
  assert.ok(/spawnTracked\(options\.binary, \[\], \{[\s\S]{0,120}env,/u.test(sage));
});

test("main.zig resolves the data dir once and hands it to the runner", () => {
  // main.zig resolves that dir before it opens the journal, so the call it
  // hands to runner.runWithOptions must carry the resolved value instead of
  // letting the runner resolve it again. Read the call block, not the whole
  // file: the App initializer above assigns its own `.data_dir`, so a bare
  // search for that line still passes after the runner's argument is deleted.
  const main = read("src/main.zig");
  const start = main.indexOf("runner.runWithOptions(");
  assert.notEqual(start, -1, "src/main.zig calls runner.runWithOptions");
  const end = main.indexOf("}, init);", start);
  assert.notEqual(end, -1, "the call has an inline options literal");
  const call = main.slice(start, end);
  assert.ok(
    call.includes(".data_dir = data_dir,"),
    "src/main.zig does not pass its resolved data dir to runner.runWithOptions, so the runner resolves the platform data dir itself."
  );
  // One open: the journal main.zig opened, with its data dir and migrations
  // already applied, is the database the runtime gets.
  assert.ok(
    call.includes(".relational_store = app.store.db.binding(),"),
    "src/main.zig does not hand the journal it already opened to runner.runWithOptions, so the runner opens a second app.db."
  );
});

test("runner.zig opens one store and resolves the data dir in one place", () => {
  const runner = read("src/runner.zig");
  assert.ok(
    runner.includes("if (options.relational_store == null)"),
    "src/runner.zig opens a relational store even when the app already opened one."
  );
  assert.ok(
    runner.includes("fn resolveStoreDataDir("),
    "src/runner.zig resolves the store data dir without a helper that honors the app's resolved data dir."
  );
  assert.ok(
    runner
      .split("\n")
      .filter((line) => line.includes("resolveStoreDataDir("))
      .some((line) => line.includes("options.data_dir")),
    "src/runner.zig opens a store without passing the app's resolved data dir."
  );
  // Every data-dir resolution goes through that helper, so no store branch can
  // resolve the platform dir on its own. A raw resolveOne in a store branch is
  // the second app.db this guard exists to catch.
  let inHelper = false;
  let calls = 0;
  let honored = 0;
  for (const line of runner.split("\n")) {
    if (line.startsWith("fn resolveStoreDataDir(")) {
      inHelper = true;
    }
    if (inHelper && line.startsWith("}")) {
      inHelper = false;
    }
    if (line.includes("native_sdk.app_dirs.resolveOne(")) {
      calls += 1;
      if (inHelper) {
        honored += 1;
      }
    }
  }
  assert.ok(
    calls > 0 && calls === honored,
    "src/runner.zig resolves a data dir outside resolveStoreDataDir, so a store open can ignore the app's resolved data dir."
  );
});
