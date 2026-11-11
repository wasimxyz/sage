import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { hasExited } from "./proc.ts";
import {
  automationDirOf,
  discoveryFileOf,
  installPrefix,
  nativeBuildArgs,
  prepareDataDir,
  removeBuilds,
  sageBinary,
  sageEnv,
  startSage,
} from "./sage.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern1 = /Sage eval/u;
const pattern2 = /agent-server\.json[\s\S]*no window server/u;
const pattern3 = /automation did not become ready/u;

test("builds install under one prefix per memory value", () => {
  assert.equal(installPrefix("/repo", "on"), "/repo/zig-out/eval-mem1");
  assert.equal(installPrefix("/repo", "off"), "/repo/zig-out/eval-mem0");
  assert.equal(sageBinary("/repo", "on"), "/repo/zig-out/eval-mem1/bin/Sage");
  assert.deepEqual(nativeBuildArgs("/repo/zig-out/eval-mem1", "on"), [
    "build",
    "-Dinstall-prefix=/repo/zig-out/eval-mem1",
    "-Dautomation=true",
    "-Dmemory=true",
  ]);
  assert.equal(nativeBuildArgs("/p", "off").at(-1), "-Dmemory=false");
});

test("removeBuilds clears both installs", (t) => {
  const root = tempDir(t);
  for (const memory of ["on", "off"] as const) {
    mkdirSync(join(installPrefix(root, memory), "bin"), { recursive: true });
  }
  removeBuilds(root);
  assert.equal(existsSync(installPrefix(root, "on")), false);
  assert.equal(existsSync(installPrefix(root, "off")), false);
});

test("a data directory holds a stub frontend and a link to app.json", (t) => {
  const parent = tempDir(t);
  const dir = prepareDataDir("/repo", parent);
  assert.ok(dir.startsWith(parent));
  assert.match(
    readFileSync(join(dir, "frontend", "dist", "index.html"), "utf8"),
    pattern1
  );
  assert.equal(lstatSync(join(dir, "app.json")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(dir, "app.json")), "/repo/app.json");
  assert.equal(discoveryFileOf(dir), join(dir, "agent-server.json"));
  assert.equal(
    automationDirOf(dir),
    join(dir, ".zig-cache", "native-sdk-automation")
  );
  assert.notEqual(prepareDataDir("/repo", parent), dir);
});

test("Sage's environment sets its folder and models, and drops what picks its mode", () => {
  const env = sageEnv({
    base: {
      AI_GATEWAY_API_KEY: "secret",
      HOME: "/home/x",
      NATIVE_SDK_MODE: "dev",
      NATIVE_SDK_PATH: "/sdk",
      PATH: "/usr/bin",
      SAGE_DATA_DIR: "/real/journal",
      SAGE_DISCOVERY_FILE: "/real/agent-server.json",
      SAGE_TODAY: "2026-01-01",
    },
    dataDir: "/tmp/sage-eval-x",
    embedModel: "embed-m",
    ollamaBin: "/opt/ollama",
    summaryModel: "sum-m",
  });
  assert.deepEqual(env, {
    HOME: "/home/x",
    PATH: "/usr/bin",
    SAGE_DATA_DIR: "/tmp/sage-eval-x",
    SAGE_EMBED_MODEL: "embed-m",
    SAGE_OLLAMA_PATH: "/opt/ollama",
    SAGE_SUMMARY_MODEL: "sum-m",
  });
});

test("a Dream prompt folder reaches Sage only for a variant", () => {
  const base = {
    base: { PATH: "/usr/bin" },
    dataDir: "/tmp/d",
    embedModel: "e",
    ollamaBin: "/o",
    summaryModel: "s",
  };
  assert.equal(sageEnv(base).SAGE_EVAL_DREAM_PROMPTS, undefined);
  assert.equal(
    sageEnv({
      ...base,
      dreamPromptsDir: "/repo/agent/evals/dream-prompts/careful",
    }).SAGE_EVAL_DREAM_PROMPTS,
    "/repo/agent/evals/dream-prompts/careful"
  );
});

// A stand-in for the automation build: it writes agent-server.json and the
// automation folder in its working directory, records its environment, and
// stays up until it is stopped.
const fakeSage = `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync(".zig-cache/native-sdk-automation", { recursive: true });
fs.writeFileSync("env.json", JSON.stringify({
  SAGE_DATA_DIR: process.env.SAGE_DATA_DIR,
  SAGE_SUMMARY_MODEL: process.env.SAGE_SUMMARY_MODEL,
  SAGE_OLLAMA_PATH: process.env.SAGE_OLLAMA_PATH,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? null,
}));
fs.writeFileSync("agent-server.json", JSON.stringify({ socket: "/tmp/x.sock", token: "t" }));
console.log("sage is up");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`;

function installFake(dir: string, script: string): string {
  const path = join(dir, "Sage");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

test("startSage launches the binary in the data dir and waits for it", async (t) => {
  const dir = tempDir(t);
  const dataDir = prepareDataDir("/repo", dir);
  const waited: string[] = [];
  const run = await startSage({
    automateWait: (cwd) => {
      waited.push(cwd);
      return Promise.resolve(true);
    },
    binary: installFake(dir, fakeSage),
    dataDir,
    embedModel: "embed-m",
    ollamaBin: "/opt/ollama",
    startTimeoutMs: 15_000,
    summaryModel: "sum-m",
  });
  try {
    assert.deepEqual(waited, [dataDir]);
    assert.equal(run.automationCwd, dataDir);
    assert.equal(run.discoveryFile, join(dataDir, "agent-server.json"));
    assert.equal(run.manifestPath, join(dataDir, "manifest.json"));
    assert.equal(hasExited(run.child), false);
    const seen = JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"));
    assert.equal(seen.SAGE_DATA_DIR, dataDir);
    assert.equal(seen.SAGE_SUMMARY_MODEL, "sum-m");
    assert.equal(seen.SAGE_OLLAMA_PATH, "/opt/ollama");
  } finally {
    await run.stop();
  }
  assert.equal(hasExited(run.child), true);
});

test("startSage fails with the log when Sage exits before it is ready", async (t) => {
  const dir = tempDir(t);
  const dataDir = prepareDataDir("/repo", dir);
  await assert.rejects(
    startSage({
      automateWait: () => Promise.resolve(true),
      binary: installFake(
        dir,
        "#!/bin/sh\necho 'no window server' >&2\nexit 1\n"
      ),
      dataDir,
      embedModel: "e",
      ollamaBin: "/o",
      startTimeoutMs: 10_000,
      summaryModel: "s",
    }),
    pattern2
  );
});

test("startSage stops Sage when automation never answers", async (t) => {
  const dir = tempDir(t);
  const dataDir = prepareDataDir("/repo", dir);
  await assert.rejects(
    startSage({
      automateWait: () => Promise.resolve(false),
      binary: installFake(dir, fakeSage),
      dataDir,
      embedModel: "e",
      ollamaBin: "/o",
      startTimeoutMs: 15_000,
      summaryModel: "s",
    }),
    pattern3
  );
});
