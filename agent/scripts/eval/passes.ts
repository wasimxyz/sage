// The three passes, each one an `eve eval` process.
//
//   person   today's checks and Dream accuracy for one person's snapshot
//   chat     generation: sends messages to the overlay's Chat agent
//   grade    reads the transcripts and calls the cloud judge
//
// `person` and `grade` never send a message, so they point at the stub target.
// `chat` points at the overlay `eve dev` server and carries Sage's token.
// Gateway credentials go to these client processes only.

import { join } from "node:path";

import { EVAL_ENV } from "../../evals/lib/schema.ts";
import {
  type Env,
  gatewayCredentials,
  prependPath,
  redact,
  withoutSageOnly,
} from "./env.ts";
import { EVAL_TODAY, eveBin } from "./eve.ts";
import type { PassName } from "./plan.ts";
import {
  captureCommand,
  type RunResult,
  runCommand,
  succeeded,
} from "./proc.ts";

/** Not in EVAL_ENV: the grader reads it to tag its gateway calls. */
export const ENV_SWEEP_ID = "SAGE_EVAL_SWEEP_ID";

/** Not in EVAL_ENV: the person pass reads it to key its Dream grades. */
export const ENV_DREAM_KEY = "SAGE_EVAL_DREAM_KEY";

/** Chat generation runs one eval at a time, because local models cannot share the GPU. */
export const PASS_CONCURRENCY: Readonly<Record<PassName, number>> = {
  chat: 1,
  grade: 4,
  person: 1,
};

/** The most grade processes running behind the generation of the next setup. */
export const MAX_GRADE_PROCESSES = 2;

export interface PassEnvInput {
  agentDir: string;
  base?: Env;
  /** Credentials for the cloud judge and simulated user. */
  credentials: Record<string, string>;
  dataDir: string;
  dataRoot: string;
  discoveryFile: string;
  /** The key of this person's Dream snapshot. The person pass keys its grades by it. */
  dreamKey?: string;
  manifest: string;
  models: { chat: string; embed: string; summary: string };
  person: string;
  repoRoot: string;
  results: string;
  runDir: string;
  setupId: string;
  sweepFile: string;
  /** The sweep's id. The grader tags its gateway calls with it. */
  sweepId: string;
  /** Sage's token. Only the chat pass sends it. */
  token?: string;
  transcripts: string;
}

/**
 * The environment of one `eve eval` client. The pass variables come from
 * EVAL_ENV in schema.ts. The gateway credentials are here and nowhere else.
 *
 * `SAGE_EVAL_DREAM_PROMPTS` is not here. Only Sage reads it (see `sageEnv`),
 * and a Dream prompt folder is not something an eval file needs.
 */
export function buildPassEnv(input: PassEnvInput): Record<string, string> {
  const base = withoutSageOnly(input.base ?? process.env);
  const env: Record<string, string> = {
    ...base,
    ...input.credentials,
    EVE_TELEMETRY_DISABLED: "1",
    PATH: prependPath(join(input.agentDir, "node_modules", ".bin"), base.PATH),
    SAGE_CHAT_MODEL: input.models.chat,
    SAGE_DATA_DIR: input.dataDir,
    SAGE_EMBED_MODEL: input.models.embed,
    SAGE_REPO_ROOT: input.repoRoot,
    SAGE_SUMMARY_MODEL: input.models.summary,
    [EVAL_ENV.data]: input.dataRoot,
    [EVAL_ENV.discoveryFile]: input.discoveryFile,
    [EVAL_ENV.manifest]: input.manifest,
    [EVAL_ENV.person]: input.person,
    [EVAL_ENV.results]: input.results,
    [EVAL_ENV.runDir]: input.runDir,
    [EVAL_ENV.setupId]: input.setupId,
    [EVAL_ENV.sweepFile]: input.sweepFile,
    [ENV_SWEEP_ID]: input.sweepId,
    [EVAL_ENV.today]: EVAL_TODAY,
    [EVAL_ENV.transcripts]: input.transcripts,
  };
  if (input.dreamKey !== undefined) {
    env[ENV_DREAM_KEY] = input.dreamKey;
  }
  if (input.token !== undefined) {
    // eve applies this bearer only to a URL target.
    env.EVE_EVAL_AUTH_TOKEN = input.token;
  }
  return env;
}

export interface JudgeCheckEnvInput {
  agentDir: string;
  base?: Env;
  /** Credentials for the cloud judge. */
  credentials: Record<string, string>;
  /** Where the check's rows go. */
  results: string;
  runDir: string;
  sweepFile: string;
  sweepId: string;
}

/**
 * The environment of the judge check. It has no person, no setup, and no
 * Sage, so it carries none of the variables that name them, even when the
 * shell that started the runner set some. The judge reads the sweep file for
 * its model and cap, and counts its spending in the sweep's ledger.
 */
export function buildJudgeCheckEnv(
  input: JudgeCheckEnvInput
): Record<string, string> {
  const base = withoutSageOnly(input.base ?? process.env);
  for (const name of [
    EVAL_ENV.discoveryFile,
    EVAL_ENV.manifest,
    EVAL_ENV.person,
    EVAL_ENV.setupId,
    EVAL_ENV.transcripts,
    ENV_DREAM_KEY,
    "SAGE_DATA_DIR",
  ]) {
    delete base[name];
  }
  return {
    ...base,
    ...input.credentials,
    EVE_TELEMETRY_DISABLED: "1",
    PATH: prependPath(join(input.agentDir, "node_modules", ".bin"), base.PATH),
    [EVAL_ENV.results]: input.results,
    [EVAL_ENV.runDir]: input.runDir,
    [EVAL_ENV.sweepFile]: input.sweepFile,
    [ENV_SWEEP_ID]: input.sweepId,
    [EVAL_ENV.today]: EVAL_TODAY,
  };
}

export function credentialsFrom(
  env: Env = process.env
): Record<string, string> {
  return gatewayCredentials(env);
}

export interface EvalCommand {
  agentDir: string;
  /** Eve filters from ARGS, such as `--tag example`. */
  filters: readonly string[];
  /** Eval ids or folder prefixes, such as `chat/facts`. */
  prefixes: readonly string[];
}

export interface EvalRunCommand extends EvalCommand {
  concurrency: number;
  url: string;
}

/** The arguments of a pass: `eval <prefixes> --max-concurrency N --url U <filters>`. */
export function evalRunArgs(command: EvalRunCommand): string[] {
  return [
    "eval",
    ...command.prefixes,
    "--max-concurrency",
    String(command.concurrency),
    "--url",
    command.url,
    ...command.filters,
  ];
}

/** The arguments that list the evals a pass would run. */
export function evalListArgs(command: EvalCommand): string[] {
  return ["eval", ...command.prefixes, "--list", "--json", ...command.filters];
}

const listStartPattern = /^\[/mu;

/** The JSON array in `--list --json` output, which can follow other lines. */
export function parseEvalList(stdout: string): string[] | null {
  const start = stdout.search(listStartPattern);
  if (start === -1) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.flatMap((row) =>
      row !== null &&
      typeof row === "object" &&
      "id" in row &&
      typeof (row as { id: unknown }).id === "string"
        ? [(row as { id: string }).id]
        : []
    );
  } catch {
    return null;
  }
}

export type ListOutcome =
  | { ids: string[]; ok: true }
  | { message: string; ok: false };

/**
 * Lists the evals a pass would run for this environment. Exit code 2 means
 * eve found nothing that matches, which is an empty list here.
 */
export async function listEvals(
  command: EvalCommand,
  env: Record<string, string>
): Promise<ListOutcome> {
  if (command.prefixes.length === 0) {
    return { ids: [], ok: true };
  }
  const result = await captureCommand(
    eveBin(command.agentDir),
    evalListArgs(command),
    { cwd: command.agentDir, env }
  );
  if (result.code === 2) {
    return { ids: [], ok: true };
  }
  const ids = result.code === 0 ? parseEvalList(result.stdout) : null;
  if (ids === null) {
    return {
      message: `Could not list evals (${command.prefixes.join(", ")}): exit ${result.code}. ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
      ok: false,
    };
  }
  return { ids, ok: true };
}

export type PassStatus = "ok" | "evals-failed" | "crashed";

export interface PassOutcome {
  code: number | null;
  durationMs: number;
  status: PassStatus;
}

/** Exit 0 passed. Exit 1 means some eval failed, and its rows are recorded. Anything else is a crash. */
export function statusOf(result: RunResult): PassStatus {
  if (succeeded(result)) {
    return "ok";
  }
  return result.code === 1 && result.signal === null
    ? "evals-failed"
    : "crashed";
}

export async function runEvalPass(
  command: EvalRunCommand,
  options: {
    echoPrefix?: string;
    env: Record<string, string>;
    logFile: string;
    secrets?: readonly string[];
  }
): Promise<PassOutcome> {
  const result = await runCommand(
    eveBin(command.agentDir),
    evalRunArgs(command),
    {
      cwd: command.agentDir,
      echoPrefix: options.echoPrefix,
      env: options.env,
      logFile: options.logFile,
      redactions: options.secrets,
    }
  );
  return {
    code: result.code,
    durationMs: result.durationMs,
    status: statusOf(result),
  };
}

/** For error messages: the command line, with the token and gateway keys replaced. */
export function describeCommand(
  args: readonly string[],
  secrets: readonly string[]
): string {
  return redact(`eve ${args.join(" ")}`, secrets);
}

// ---------------------------------------------------------------------------
// The background pool
// ---------------------------------------------------------------------------

/**
 * Runs at most `limit` jobs at once. `submit` returns as soon as the job has
 * started, and waits first when every slot is busy, so the generation of the
 * next setup never piles up more grading than the Mac can hold.
 */
export class JobPool {
  private readonly limit: number;
  private readonly running = new Set<Promise<void>>();
  private peak = 0;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  get active(): number {
    return this.running.size;
  }

  get highWater(): number {
    return this.peak;
  }

  async submit(job: () => Promise<void>): Promise<void> {
    while (this.running.size >= this.limit) {
      // biome-ignore lint/performance/noAwaitInLoops: wait for a slot, then check again.
      await Promise.race(this.running);
    }
    const task: Promise<void> = job()
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(task);
      });
    this.running.add(task);
    this.peak = Math.max(this.peak, this.running.size);
  }

  /** Resolves when every submitted job has finished. */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: jobs may add jobs, so look again each time.
      await Promise.all([...this.running]);
    }
  }
}
