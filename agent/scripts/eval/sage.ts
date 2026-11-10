// The throwaway Sage that each person gets.
//
// The runner builds Sage once per memory value, under its own install prefix,
// so `zig-out/bin/Sage` stays the `make build` binary. Each person then gets a
// fresh data directory (a stub frontend and a link to `app.json`) and a Sage
// started from that directory. The eval Sage is a bare binary, not an app
// bundle, so it runs the Ollama named by `SAGE_OLLAMA_PATH` on the dev port
// (11436) and starts it at launch. It never touches the real journal: it opens
// only the folder `SAGE_DATA_DIR` names.

import { type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Memory } from "../../evals/lib/schema.ts";
import { type Env, withoutSecrets } from "./env.ts";
import {
  captureCommand,
  hasExited,
  readLogTail,
  runCommand,
  spawnTracked,
  stopProcess,
  succeeded,
  waitFor,
} from "./proc.ts";

const stubIndexHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sage eval</title></head><body></body></html>\n';

/** Where the automation build for a memory value is installed. */
export function installPrefix(root: string, memory: Memory): string {
  return join(root, "zig-out", memory === "on" ? "eval-mem1" : "eval-mem0");
}

export function sageBinary(root: string, memory: Memory): string {
  return join(installPrefix(root, memory), "bin", "Sage");
}

/**
 * `native build` forwards -D flags only and passes no prefix of its own for an
 * ejected app, so the throwaway install arrives as an option, not --prefix.
 * The automation flag is why these builds live under their own prefix.
 */
export function nativeBuildArgs(prefix: string, memory: Memory): string[] {
  return [
    "build",
    `-Dinstall-prefix=${prefix}`,
    "-Dautomation=true",
    `-Dmemory=${memory === "on" ? "true" : "false"}`,
  ];
}

/** Builds Sage with automation for one memory value. Returns the binary's path. */
export async function buildSage(options: {
  logFile: string;
  memory: Memory;
  root: string;
}): Promise<string> {
  const { memory, root } = options;
  const prefix = installPrefix(root, memory);
  console.log(`Building Sage with memory ${memory} (${prefix})`);
  const result = await runCommand("native", nativeBuildArgs(prefix, memory), {
    cwd: root,
    echoPrefix: `[build mem-${memory}]`,
    env: withoutSecrets(),
    logFile: options.logFile,
  });
  if (!succeeded(result)) {
    throw new Error(
      `native build failed for memory ${memory} (exit ${result.code}). Log: ${options.logFile}`
    );
  }
  const binary = sageBinary(root, memory);
  if (!existsSync(binary)) {
    throw new Error(`Sage was not built at ${binary}.`);
  }
  return binary;
}

/** Deletes both automation installs. Safe to call twice. */
export function removeBuilds(root: string): void {
  for (const memory of ["on", "off"] as const) {
    rmSync(installPrefix(root, memory), { force: true, recursive: true });
  }
}

/** A fresh data directory with the stub frontend and a link to `app.json`. */
export function prepareDataDir(root: string, parent = tmpdir()): string {
  const dataDir = mkdtempSync(join(parent, "sage-eval-"));
  mkdirSync(join(dataDir, "frontend", "dist"), { recursive: true });
  writeFileSync(join(dataDir, "frontend", "dist", "index.html"), stubIndexHtml);
  symlinkSync(join(root, "app.json"), join(dataDir, "app.json"));
  return dataDir;
}

export function discoveryFileOf(dataDir: string): string {
  return join(dataDir, "agent-server.json");
}

export function automationDirOf(dataDir: string): string {
  return join(dataDir, ".zig-cache", "native-sdk-automation");
}

export interface SageEnvOptions {
  base?: Env;
  dataDir: string;
  /** A folder of Dream prompts, for a Dream prompt variant. Omit for `baseline`. */
  dreamPromptsDir?: string;
  embedModel: string;
  ollamaBin: string;
  summaryModel: string;
}

/**
 * The environment for a Sage launch. It starts from the runner's environment
 * with credentials removed, drops the variables that change how Sage picks its
 * mode or folder, and sets only what the eval needs. There is no
 * NATIVE_SDK_MODE: Sage picks the dev port and `SAGE_OLLAMA_PATH` because this
 * binary does not sit in an app bundle.
 */
export function sageEnv(options: SageEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    withoutSecrets(options.base ?? process.env)
  )) {
    if (!(name.startsWith("SAGE_") || name.startsWith("NATIVE_SDK_"))) {
      env[name] = value;
    }
  }
  env.SAGE_DATA_DIR = options.dataDir;
  env.SAGE_EMBED_MODEL = options.embedModel;
  env.SAGE_OLLAMA_PATH = options.ollamaBin;
  env.SAGE_SUMMARY_MODEL = options.summaryModel;
  if (options.dreamPromptsDir !== undefined) {
    env.SAGE_EVAL_DREAM_PROMPTS = options.dreamPromptsDir;
  }
  return env;
}

export interface SageRun {
  /** The folder with `.zig-cache/native-sdk-automation`, which the seed script drives. */
  automationCwd: string;
  child: ChildProcess;
  dataDir: string;
  discoveryFile: string;
  logFile: string;
  manifestPath: string;
  stop(): Promise<void>;
}

export interface StartSageOptions extends SageEnvOptions {
  /** Waits for Sage's automation to answer. Tests replace it. */
  automateWait?: (cwd: string) => Promise<boolean>;
  binary: string;
  startTimeoutMs?: number;
}

async function nativeAutomateWait(cwd: string): Promise<boolean> {
  const waited = await captureCommand("native", ["automate", "wait"], {
    cwd,
    env: withoutSecrets(),
    timeoutMs: 120_000,
  });
  return waited.code === 0;
}

/** Starts Sage in its data directory and waits until automation answers. */
export async function startSage(options: StartSageOptions): Promise<SageRun> {
  const { dataDir } = options;
  const logFile = join(dataDir, "sage.log");
  const env = sageEnv(options);
  const child = spawnTracked(options.binary, [], {
    cwd: dataDir,
    detached: true,
    env,
    logFile,
  });
  const stop = async (): Promise<void> => {
    await stopProcess(child, { graceMs: 20_000, group: true });
  };
  const discoveryFile = discoveryFileOf(dataDir);
  const automationDir = automationDirOf(dataDir);
  const ready = await waitFor(
    () => existsSync(discoveryFile) && existsSync(automationDir),
    {
      giveUp: () => (hasExited(child) ? "Sage exited before it was ready." : null),
      intervalMs: 100,
      timeoutMs: options.startTimeoutMs ?? 30_000,
    }
  );
  if (!ready.ok) {
    const what = existsSync(discoveryFile)
      ? "its automation folder"
      : "agent-server.json";
    const tail = readLogTail(logFile);
    await stop();
    throw new Error(
      `Sage did not write ${what} (${ready.reason}). Log:\n${tail || "(empty)"}`
    );
  }
  const automateWait = options.automateWait ?? nativeAutomateWait;
  if (!(await automateWait(dataDir))) {
    const tail = readLogTail(logFile);
    await stop();
    throw new Error(
      `Sage automation did not become ready. Log:\n${tail || "(empty)"}`
    );
  }
  return {
    automationCwd: dataDir,
    child,
    dataDir,
    discoveryFile,
    logFile,
    manifestPath: join(dataDir, "manifest.json"),
    stop,
  };
}
