// The headless `eve dev` servers the passes talk to.
//
// `eve eval` sends EVE_EVAL_AUTH_TOKEN only to a URL target. For a local
// target it starts its own server and sends no token, and Chat answers 401. So
// the runner starts the server itself, on loopback and a free port, from an
// overlay root (see overlay.ts), and points each pass at it with `--url`.
//
// The server checks the token in the throwaway Sage's agent-server.json
// (SAGE_DISCOVERY_FILE). The runner reads the same file for the client's
// token. The token is never printed, never comes from agent/.env, and never
// goes to the server's own environment.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  addNodeOption,
  type Env,
  prependPath,
  withoutSageOnly,
} from "./env.ts";
import {
  hasExited,
  readLogTail,
  spawnTracked,
  stopProcess,
  waitFor,
} from "./proc.ts";

/** Where eve installs its CLI. */
export function eveBin(agentDir: string): string {
  return join(agentDir, "node_modules", ".bin", "eve");
}

/**
 * No UI, loopback only, and a free port, so the server cannot collide with
 * the `make dev` server on 2000. `--no-default-extensions` matches the server
 * eve starts for a local target.
 */
export const EVE_DEV_ARGS = [
  "dev",
  "--no-ui",
  "--no-default-extensions",
  "--host",
  "127.0.0.1",
  "--port",
  "0",
] as const;

/** The day every pass treats as today, later than every fixture entry. */
export const EVAL_TODAY = "2026-11-15";

export function workflowGuardPreload(agentDir: string): string {
  return join(agentDir, "agent", "lib", "workflow-guard-preload.ts");
}

export interface EveDevEnvOptions {
  agentDir: string;
  base?: Env;
  /** The throwaway Sage's agent-server.json. The server reads the token there. */
  discoveryFile?: string;
  ollamaBaseUrl: string;
  /** Load the workflow guard ahead of the server, as the packaged app does. */
  withWorkflowGuard: boolean;
}

/**
 * The environment for an `eve dev` server. It carries no credentials: the
 * gateway keys, the Blob token, and the eval client's token are not here.
 */
export function eveDevEnv(options: EveDevEnvOptions): Record<string, string> {
  const base = withoutSageOnly(options.base ?? process.env);
  const env: Record<string, string> = {
    ...base,
    EVE_TELEMETRY_DISABLED: "1",
    OLLAMA_BASE_URL: options.ollamaBaseUrl,
    PATH: prependPath(
      join(options.agentDir, "node_modules", ".bin"),
      base.PATH
    ),
    SAGE_TODAY: EVAL_TODAY,
  };
  if (options.discoveryFile !== undefined) {
    env.SAGE_DISCOVERY_FILE = options.discoveryFile;
  }
  if (options.withWorkflowGuard) {
    env.NODE_OPTIONS = addNodeOption(
      base.NODE_OPTIONS,
      `--import="${workflowGuardPreload(options.agentDir)}"`
    );
  }
  return env;
}

const listeningPattern =
  /server listening at http:\/\/127\.0\.0\.1:(?<port>\d+)/gu;

/**
 * The port in eve's last "server listening at" line, or null before one
 * appears. The last one wins, so a log that holds an earlier server's line
 * cannot send the runner to a port that is gone.
 */
export function parseListeningPort(logText: string): number | null {
  const port = [...logText.matchAll(listeningPattern)].at(-1)?.groups?.port;
  return port === undefined ? null : Number(port);
}

/** Health is public, so this probe sends no Authorization header. */
export async function healthOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/eve/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The token Sage wrote for this launch. It is returned, never printed. */
export function readServerToken(discoveryFile: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(discoveryFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the agent-server token from ${discoveryFile}.`,
      { cause: error }
    );
  }
  const token =
    parsed !== null && typeof parsed === "object" && "token" in parsed
      ? (parsed as { token: unknown }).token
      : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`Sage wrote no agent-server token in ${discoveryFile}.`);
  }
  return token;
}

export interface EveServer {
  logFile: string;
  stop: () => Promise<void>;
  url: string;
}

export interface StartEveServerOptions extends EveDevEnvOptions {
  logFile: string;
  /** The overlay root to run `eve dev` from. */
  root: string;
  startTimeoutMs?: number;
}

/** Starts `eve dev`, parses its port, and waits for /eve/v1/health. */
export async function startEveServer(
  options: StartEveServerOptions
): Promise<EveServer> {
  // A fresh log for each server: the port is read from it.
  mkdirSync(dirname(options.logFile), { recursive: true });
  writeFileSync(options.logFile, "");
  const child = spawnTracked(eveBin(options.agentDir), EVE_DEV_ARGS, {
    cwd: options.root,
    detached: true,
    env: eveDevEnv(options),
    logFile: options.logFile,
  });
  const timeoutMs = options.startTimeoutMs ?? 120_000;
  const stop = async (): Promise<void> => {
    // eve's dev command closes the detached server it forked, then exits, so
    // the port is free before the next server starts.
    await stopProcess(child, { graceMs: 20_000, group: true });
  };
  const giveUp = (): string | null =>
    hasExited(child) ? "The server exited." : null;
  let url: string | null = null;
  const listening = await waitFor(
    () => {
      const port = parseListeningPort(readLogTail(options.logFile, 200));
      if (port !== null) {
        url = `http://127.0.0.1:${port}`;
      }
      return url !== null;
    },
    { giveUp, intervalMs: 500, timeoutMs }
  );
  if (!listening.ok || url === null) {
    const tail = readLogTail(options.logFile);
    await stop();
    throw new Error(
      `The eval agent server did not report a port (${listening.ok ? "no port" : listening.reason}). Log:\n${tail || "(empty)"}`
    );
  }
  const base: string = url;
  const healthy = await waitFor(() => healthOk(base), {
    giveUp,
    intervalMs: 500,
    timeoutMs,
  });
  if (!healthy.ok) {
    const tail = readLogTail(options.logFile);
    await stop();
    throw new Error(
      `The eval agent server did not answer /eve/v1/health (${healthy.reason}). Log:\n${tail || "(empty)"}`
    );
  }
  return { logFile: options.logFile, stop, url: base };
}
