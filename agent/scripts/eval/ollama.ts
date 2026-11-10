// The pinned Ollama, for pulls and for model checks.
//
// The binary comes from scripts/fetch-ollama.sh. The eval Sage is a bare
// binary, not an app bundle, so it runs that Ollama itself on 127.0.0.1:11436
// (`SAGE_OLLAMA_PATH`). Pulls need a server too. Before the first Sage starts,
// this module runs a short-lived server on the same port, pulls and checks
// models through it, and stops it, so the first Sage can bind the port.
//
// Docs: https://docs.ollama.com/api/show, /api/ps, /api/generate (an empty
// prompt loads a model, `keep_alive: 0` unloads it).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withoutSecrets } from "./env.ts";
import { readLogTail, spawnTracked, stopProcess, waitFor } from "./proc.ts";

export const OLLAMA_HOST = "127.0.0.1:11436";

const requestTimeoutMs = 10_000;
const loadTimeoutMs = 10 * 60 * 1000;

export function ollamaUrl(host: string, path: string): string {
  return `http://${host}${path}`;
}

/** The native API prefix the Chat agent and the cache-key lookup use. */
export function ollamaApiBase(host: string): string {
  return ollamaUrl(host, "/api");
}

/** Runs scripts/fetch-ollama.sh and returns the binary's path. Progress goes to stderr. */
export function fetchPinnedOllama(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [join(root, "scripts", "fetch-ollama.sh")], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const path = out.trim().split("\n").at(-1)?.trim() ?? "";
      if (code === 0 && path.length > 0) {
        resolve(path);
      } else {
        reject(new Error("Could not get the pinned Ollama build."));
      }
    });
  });
}

export async function ollamaUp(host: string): Promise<boolean> {
  try {
    const response = await fetch(ollamaUrl(host, "/api/version"), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function ollamaEnv(host: string): Record<string, string> {
  return {
    ...withoutSecrets(),
    OLLAMA_HOST: host,
    OLLAMA_NOPRUNE: "1",
    OLLAMA_NO_CLOUD: "1",
  };
}

export interface PullServer {
  logFile: string;
  stop(): Promise<void>;
}

/**
 * Starts `ollama serve` on `host` and waits for it. Refuses when something
 * already answers there: that is `make dev`, or another eval.
 */
export async function startPullServer(options: {
  bin: string;
  host: string;
  startTimeoutMs?: number;
}): Promise<PullServer> {
  const { bin, host } = options;
  if (await ollamaUp(host)) {
    throw new Error(
      `Port ${host.split(":").at(-1)} is already in use. Stop make dev, or another eval, then run make eval again.`
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-ollama-"));
  const logFile = join(dir, "ollama.log");
  const child = spawnTracked(bin, ["serve"], {
    detached: true,
    env: ollamaEnv(host),
    logFile,
  });
  const ready = await waitFor(() => ollamaUp(host), {
    giveUp: () =>
      child.exitCode !== null || child.signalCode !== null
        ? "Ollama exited."
        : null,
    intervalMs: 500,
    timeoutMs: options.startTimeoutMs ?? 30_000,
  });
  const stop = async (): Promise<void> => {
    await stopProcess(child, { graceMs: 10_000, group: true });
    rmSync(dir, { force: true, recursive: true });
  };
  if (!ready.ok) {
    const tail = readLogTail(logFile);
    await stop();
    throw new Error(
      `Ollama did not start on ${host}. Log:\n${tail || "(empty)"}`
    );
  }
  return { logFile, stop };
}

/** Waits until nothing answers on `host`, after a Sage stops its Ollama. */
export async function waitForOllamaGone(
  host: string,
  timeoutMs = 60_000
): Promise<void> {
  const gone = await waitFor(async () => !(await ollamaUp(host)), {
    intervalMs: 250,
    timeoutMs,
  });
  if (!gone.ok) {
    throw new Error(
      `Ollama is still answering on ${host} after Sage stopped. Stop it, then run make eval again.`
    );
  }
}

/** `ollama pull <model>` with its progress on the console. */
export function pullModel(
  bin: string,
  host: string,
  model: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Pulling ${model}`);
    const child: ChildProcess = spawn(bin, ["pull", model], {
      env: ollamaEnv(host),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Could not pull ${model} (ollama exit ${code}).`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Model checks
// ---------------------------------------------------------------------------

export interface ModelInfo {
  capabilities: string[] | null;
  /** The values the model's `think` field takes, when it says. */
  thinkingValues: (boolean | string)[] | null;
}

async function postJson(
  host: string,
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  return await fetch(ollamaUrl(host, path), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** `/api/show` for one model. Null when Ollama does not have it. */
export async function showModel(
  host: string,
  model: string
): Promise<ModelInfo | null> {
  const response = await postJson(
    host,
    "/api/show",
    { model },
    requestTimeoutMs
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Ollama /api/show for ${model} returned ${response.status}.`);
  }
  return parseModelInfo(await response.json());
}

export function parseModelInfo(payload: unknown): ModelInfo {
  const record =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(
        (value): value is string => typeof value === "string"
      )
    : null;
  const thinking = record.thinking;
  let thinkingValues: (boolean | string)[] | null = null;
  if (
    thinking !== null &&
    typeof thinking === "object" &&
    "values" in thinking &&
    Array.isArray((thinking as { values: unknown }).values)
  ) {
    thinkingValues = (thinking as { values: unknown[] }).values.filter(
      (value): value is boolean | string =>
        typeof value === "boolean" || typeof value === "string"
    );
  }
  return { capabilities, thinkingValues };
}

export function canThink(info: ModelInfo): boolean {
  if (info.capabilities?.includes("thinking") === true) {
    return true;
  }
  // `[false]` alone means the model does not support thinking.
  return (
    info.thinkingValues !== null &&
    info.thinkingValues.some((value) => value !== false)
  );
}

export type ModelRole = "chat" | "embed" | "summary";

const requiredCapability: Record<ModelRole, string> = {
  chat: "tools",
  embed: "embedding",
  summary: "completion",
};

/** What is wrong with using this model in this role. Empty when nothing is. */
export function modelProblems(
  model: string,
  role: ModelRole,
  info: ModelInfo | null
): string[] {
  if (info === null) {
    return [`${model} is not in Ollama.`];
  }
  if (info.capabilities === null) {
    return [`Ollama did not say what ${model} can do.`];
  }
  const needed = requiredCapability[role];
  if (info.capabilities.includes(needed)) {
    return [];
  }
  if (role === "chat") {
    return [
      `${model} cannot call tools (Ollama lists: ${info.capabilities.join(", ") || "nothing"}). Chat needs tools to search the journal.`,
    ];
  }
  return [
    `${model} cannot be the ${role} model (Ollama lists: ${info.capabilities.join(", ") || "nothing"}).`,
  ];
}

export interface ModelRoles {
  chat: string[];
  embed: string[];
  summary: string[];
}

export interface ModelCheck {
  /** Chat models that cannot think. Their think-on setups are skipped. */
  cannotThink: string[];
  /** Models that are not in Ollama yet. */
  missing: string[];
  problems: string[];
}

/** Checks every model the sweep uses. Models Ollama lacks are listed, not failed. */
export async function checkModels(
  host: string,
  roles: ModelRoles
): Promise<ModelCheck> {
  const check: ModelCheck = { cannotThink: [], missing: [], problems: [] };
  const seen = new Map<string, ModelInfo | null>();
  const lookup = async (model: string): Promise<ModelInfo | null> => {
    if (!seen.has(model)) {
      seen.set(model, await showModel(host, model));
    }
    return seen.get(model) ?? null;
  };
  for (const role of ["summary", "embed", "chat"] as const) {
    for (const model of roles[role]) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of quick local calls.
      const info = await lookup(model);
      if (info === null) {
        if (!check.missing.includes(model)) {
          check.missing.push(model);
        }
        continue;
      }
      check.problems.push(...modelProblems(model, role, info));
      if (role === "chat" && !canThink(info)) {
        check.cannotThink.push(model);
      }
    }
  }
  return check;
}

// ---------------------------------------------------------------------------
// Load and unload
// ---------------------------------------------------------------------------

/**
 * Loads a model at a context length, so the first Chat turn does not pay for
 * the load. An empty prompt loads without generating.
 */
export async function warmUpModel(
  host: string,
  model: string,
  contextLength: number,
  keepAlive = "30m"
): Promise<void> {
  const response = await postJson(
    host,
    "/api/generate",
    { keep_alive: keepAlive, model, options: { num_ctx: contextLength } },
    loadTimeoutMs
  );
  if (!response.ok) {
    throw new Error(`Ollama could not load ${model} (HTTP ${response.status}).`);
  }
  await response.arrayBuffer();
}

/** `keep_alive: 0` unloads a model now. */
export async function unloadModel(host: string, model: string): Promise<void> {
  try {
    const response = await postJson(
      host,
      "/api/generate",
      { keep_alive: 0, model },
      requestTimeoutMs * 3
    );
    await response.arrayBuffer();
  } catch {
    // A model that is not loaded, or a server that is going away, is fine.
  }
}

export interface RunningModel {
  name: string;
  size: number;
}

export async function runningModels(host: string): Promise<RunningModel[]> {
  const response = await fetch(ollamaUrl(host, "/api/ps"), {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    return [];
  }
  const payload: unknown = await response.json();
  const models =
    payload !== null &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models: unknown }).models)
      ? ((payload as { models: unknown[] }).models as Record<string, unknown>[])
      : [];
  return models.flatMap((row) =>
    typeof row.name === "string"
      ? [{ name: row.name, size: typeof row.size === "number" ? row.size : 0 }]
      : []
  );
}
