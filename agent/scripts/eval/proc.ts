// Child processes for the runner.
//
// Every long-lived child (Sage, `eve dev`, `ollama serve`) starts in its own
// process group and is tracked, so an interrupted run can still stop all of
// them. Output goes to a log file, and optionally to the console with a prefix.

import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { redact } from "./env.ts";

const lineBreakPattern = /\r?\n/u;

const live = new Set<ChildProcess>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface WaitOptions {
  /** Returns a reason to stop waiting early, or null to keep waiting. */
  giveUp?: () => string | null;
  intervalMs?: number;
  timeoutMs: number;
}

export type WaitResult = { ok: true } | { ok: false; reason: string };

/** Polls `check` until it is true, the timeout passes, or `giveUp` names a reason. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  options: WaitOptions
): Promise<WaitResult> {
  const interval = options.intervalMs ?? 200;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll depends on the one before it.
    if (await check()) {
      return { ok: true };
    }
    const reason = options.giveUp?.() ?? null;
    if (reason !== null) {
      return { ok: false, reason };
    }
    await sleep(interval);
  }
  if (await check()) {
    return { ok: true };
  }
  return { ok: false, reason: "timed out" };
}

export function appendLog(logFile: string, text: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, text, "utf8");
}

export function readLogTail(logFile: string, maxLines = 40): string {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
  return text.split(lineBreakPattern).slice(-maxLines).join("\n").trim();
}

export interface SpawnLogOptions {
  cwd?: string;
  /** Start in a new process group, so the whole tree can be stopped. */
  detached?: boolean;
  /** Print each output line to the console with this prefix. */
  echoPrefix?: string;
  /** Plain environment for the child. Nothing is inherited from this process. */
  env: Record<string, string>;
  logFile: string;
  /** Secret values to replace in logs and console output. */
  redactions?: readonly string[];
}

function pipeOutput(child: ChildProcess, options: SpawnLogOptions): void {
  const secrets = options.redactions ?? [];
  const pending = { err: "", out: "" };
  const handle = (key: "err" | "out", chunk: Buffer): void => {
    const text = redact(chunk.toString("utf8"), secrets);
    appendLog(options.logFile, text);
    if (options.echoPrefix === undefined) {
      return;
    }
    const lines = (pending[key] + text).split(lineBreakPattern);
    pending[key] = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${options.echoPrefix} ${line}\n`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => handle("out", chunk));
  child.stderr?.on("data", (chunk: Buffer) => handle("err", chunk));
  child.on("close", () => {
    if (options.echoPrefix === undefined) {
      return;
    }
    for (const rest of [pending.out, pending.err]) {
      if (rest.length > 0) {
        process.stdout.write(`${options.echoPrefix} ${rest}\n`);
      }
    }
  });
}

/** Starts a child that keeps running. Output goes to the log file. */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnLogOptions
): ChildProcess {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    detached: options.detached ?? false,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = spawn(command, [...args], spawnOptions);
  live.add(child);
  child.once("close", () => {
    live.delete(child);
  });
  child.on("error", (error) => {
    appendLog(options.logFile, `spawn error: ${error.message}\n`);
  });
  pipeOutput(child, options);
  return child;
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Stops a child with SIGTERM, then SIGKILL after the grace period. A detached
 * child's group gets a final SIGKILL, so a forked server cannot outlive it.
 */
export async function stopProcess(
  child: ChildProcess,
  options: { graceMs?: number; group?: boolean } = {}
): Promise<void> {
  const grace = options.graceMs ?? 20_000;
  const group = options.group ?? false;
  if (!hasExited(child)) {
    try {
      if (child.pid !== undefined) {
        process.kill(child.pid, "SIGTERM");
      }
    } catch {
      // Already gone.
    }
    const exited = await waitFor(() => hasExited(child), {
      intervalMs: 50,
      timeoutMs: grace,
    });
    if (!exited.ok) {
      killGroup(child, "SIGKILL");
      await waitFor(() => hasExited(child), {
        intervalMs: 50,
        timeoutMs: 5000,
      });
    }
  }
  if (group) {
    killGroup(child, "SIGKILL");
  }
}

/** Synchronous last resort for exit handlers. */
export function killAllTracked(): void {
  for (const child of live) {
    killGroup(child, "SIGKILL");
  }
  live.clear();
}

export function trackedCount(): number {
  return live.size;
}

export interface RunResult {
  code: number | null;
  durationMs: number;
  signal: NodeJS.Signals | null;
}

/** Runs a command to completion. Output goes to the log file. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: SpawnLogOptions
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawnTracked(command, args, options);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, durationMs: Date.now() - started, signal });
    };
    child.once("error", () => finish(null, null));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

export interface Captured {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Runs a short command and returns what it printed. */
export function captureCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: Record<string, string>; timeoutMs?: number }
): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      resolve({ code: null, stderr: error.message, stdout });
    });
    child.once("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

/** True when the process exited cleanly (code 0). */
export function succeeded(result: RunResult): boolean {
  return result.code === 0 && result.signal === null;
}
