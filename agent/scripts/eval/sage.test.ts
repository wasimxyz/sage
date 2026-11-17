import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import {
  hasExited,
  killAllTracked,
  terminateAllTracked,
  waitFor,
} from "./proc.ts";
import {
  automationDirOf,
  discoveryFileOf,
  endLeftoverOllama,
  installPrefix,
  nativeBuildArgs,
  ollamaPidFileOf,
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

// ---------------------------------------------------------------------------
// An interrupted run must not leave Sage's Ollama on the port
// ---------------------------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  const result = await waitFor(() => !alive(pid), {
    intervalMs: 25,
    timeoutMs: 5000,
  });
  return result.ok;
}

// How a stand-in Sage answers SIGTERM:
//   quits    stops its Ollama and removes the pid file, like a normal quit
//   ignores  does nothing, like a hung Sage
//   dies     exits at once and leaves its Ollama, like a Sage with no handler
type Mode = "dies" | "ignores" | "quits";

// Like src/ollama_server.zig: the server leads a group of its own (`.pgid = 0`),
// and its pid goes in `ollama/serve.pid`.
const sageWithOllama = (mode: Mode) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const ollama = spawn(process.env.SAGE_OLLAMA_PATH, ["serve"], { detached: true, stdio: "ignore" });
fs.mkdirSync("ollama", { recursive: true });
fs.writeFileSync("ollama/serve.pid", String(ollama.pid) + "\\n");
fs.mkdirSync(".zig-cache/native-sdk-automation", { recursive: true });
fs.writeFileSync("agent-server.json", JSON.stringify({ token: "sage-token-0123456789" }));
const mode = ${JSON.stringify(mode)};
process.on("SIGTERM", () => {
  fs.writeFileSync("got-sigterm", "yes");
  if (mode === "ignores") {
    return;
  }
  if (mode === "quits") {
    try { process.kill(-ollama.pid, "SIGTERM"); } catch {}
    fs.rmSync("ollama/serve.pid", { force: true });
  }
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

const fakeOllama = "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n";

async function startSageWithOllama(
  t: test.TestContext,
  mode: Mode
): Promise<{
  dataDir: string;
  ollamaPid: number;
  run: Awaited<ReturnType<typeof startSage>>;
}> {
  const dir = tempDir(t);
  const dataDir = prepareDataDir("/repo", dir);
  const ollamaBin = join(dir, "ollama");
  writeFileSync(ollamaBin, fakeOllama);
  chmodSync(ollamaBin, 0o755);
  const run = await startSage({
    automateWait: () => Promise.resolve(true),
    binary: installFake(dir, sageWithOllama(mode)),
    dataDir,
    embedModel: "nomic-embed-text",
    ollamaBin,
    startTimeoutMs: 15_000,
    summaryModel: "qwen3.5:9b",
  });
  const ollamaPid = Number(readFileSync(ollamaPidFileOf(dataDir), "utf8"));
  t.after(() => {
    killAllTracked();
    try {
      process.kill(-ollamaPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  assert.ok(alive(ollamaPid));
  return { dataDir, ollamaPid, run };
}

test("a normal stop lets Sage stop its own Ollama", async (t) => {
  const { dataDir, ollamaPid, run } = await startSageWithOllama(t, "quits");
  await run.stop();
  assert.equal(await gone(ollamaPid), true);
  assert.equal(existsSync(ollamaPidFileOf(dataDir)), false);
});

test("a normal stop also ends an Ollama that Sage left when it died", async (t) => {
  const { ollamaPid, run } = await startSageWithOllama(t, "dies");
  await run.stop();
  assert.equal(hasExited(run.child), true);
  assert.equal(await gone(ollamaPid), true);
});

test("killAllTracked also ends the Ollama that Sage's group does not hold", async (t) => {
  const { ollamaPid, run } = await startSageWithOllama(t, "ignores");
  // What the exit handler and the second Ctrl-C do. Sage gets SIGKILL, and its
  // Ollama is in a group of its own.
  killAllTracked();
  const exited = await waitFor(() => hasExited(run.child), {
    timeoutMs: 5000,
  });
  assert.equal(exited.ok, true);
  assert.equal(await gone(ollamaPid), true);
});

test("Ctrl-C asks Sage first, so it stops its own Ollama before anything is killed", async (t) => {
  const { dataDir, ollamaPid, run } = await startSageWithOllama(t, "quits");
  await terminateAllTracked(5000);
  assert.equal(hasExited(run.child), true);
  assert.equal(
    readFileSync(join(dataDir, "got-sigterm"), "utf8"),
    "yes",
    "Sage got SIGTERM and ran its own quit path"
  );
  assert.equal(await gone(ollamaPid), true);
});

test("Ctrl-C ends a Sage that ignores SIGTERM after the grace period, and its Ollama with it", async (t) => {
  const { ollamaPid, run } = await startSageWithOllama(t, "ignores");
  const started = Date.now();
  await terminateAllTracked(300);
  assert.ok(Date.now() - started >= 250, "it waited for the grace period");
  const exited = await waitFor(() => hasExited(run.child), {
    timeoutMs: 5000,
  });
  assert.equal(exited.ok, true);
  assert.equal(await gone(ollamaPid), true);
});

test("a pid file that names some other process is left alone", (t) => {
  const dir = tempDir(t);
  const dataDir = prepareDataDir("/repo", dir);
  const other = spawn("sleep", ["300"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  mkdirSync(join(dataDir, "ollama"), { recursive: true });
  writeFileSync(ollamaPidFileOf(dataDir), `${other.pid}\n`);
  assert.equal(endLeftoverOllama(dataDir, join(dir, "ollama")), false);
  assert.ok(other.pid !== undefined && alive(other.pid));
  // A pid file that is not a number, and no pid file, end nothing either.
  writeFileSync(ollamaPidFileOf(dataDir), "not a pid\n");
  assert.equal(endLeftoverOllama(dataDir, join(dir, "ollama")), false);
  assert.equal(endLeftoverOllama(join(dir, "nowhere"), "/o"), false);
});
