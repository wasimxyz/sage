// One person under one Dream snapshot: the unit the runner repeats.
//
// A unit starts one Sage (and so one Ollama) with the person's journal,
// restores or builds the Dream snapshot, runs the person pass, then walks the
// Chat prompts, chat models, context lengths, and thinking values. Each setup
// gets a generation pass here and a grade pass in the background.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  baselineDreamPrompt,
  dreamPromptsDir,
  repoRoot,
} from "../../evals/lib/cache.ts";
import { evalDataRoot } from "../../evals/lib/dataset.ts";
import {
  type Memory,
  type Setup,
  type SweepFile,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import { type PassFiles, personPassFiles, setupPassFiles } from "./collect.ts";
import {
  type DigestLookup,
  type DreamKey,
  dreamKeyFor,
  needsDream,
  restoreSnapshot,
  seedPerson,
  snapshotDream,
} from "./dream.ts";
import { readServerToken, startEveServer } from "./eve.ts";
import {
  ollamaApiBase,
  unloadModel,
  waitForOllamaGone,
  warmUpModel,
} from "./ollama.ts";
import type { Overlay } from "./overlay.ts";
import {
  buildPassEnv,
  type EvalCommand,
  type JobPool,
  listEvals,
  PASS_CONCURRENCY,
  type PassEnvInput,
  type PassOutcome,
  runEvalPass,
} from "./passes.ts";
import type { LoadedPerson } from "./people.ts";
import type { PassName, PassPrefixes, PlanGroup } from "./plan.ts";
import { prepareDataDir, type SageRun, startSage } from "./sage.ts";

export interface RunContext {
  abort: { aborted: boolean };
  agentDir: string;
  builds: ReadonlyMap<Memory, string>;
  /** Chat models that cannot think. Their think-on setups do not run. */
  cannotThink: ReadonlySet<string>;
  credentials: Record<string, string>;
  /** Model digests, read while an Ollama server was up. No server runs between units. */
  digests: DigestLookup;
  /** Problems the run met, for the exit code and the summary. */
  failures: string[];
  /** Eve filters from ARGS. */
  filters: readonly string[];
  /** Evals each pass listed, by person and pass, so the list runs once. */
  listCache: Map<string, string[]>;
  ollama: { bin: string; host: string };
  overlays: ReadonlyMap<string, Overlay>;
  /** Passes that exited with a failed eval. This sets the exit code. */
  passesWithFailures: number;
  people: ReadonlyMap<string, LoadedPerson>;
  pool: JobPool;
  prefixes: PassPrefixes;
  reportsDir: string;
  root: string;
  runDir: string;
  /** The `--url` of the stub target for the person and grade passes. */
  stubUrl: string;
  sweep: SweepFile;
  sweepFile: string;
  sweepId: string;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function fail(ctx: RunContext, message: string): void {
  ctx.failures.push(message);
  console.error(message);
}

function setupLabel(setup: Setup): string {
  return `${setup.chatModel} / ${setup.prompt} / think ${setup.thinking} / ctx ${setup.contextLength}`;
}

function copyIfPresent(from: string, to: string): void {
  if (existsSync(from)) {
    try {
      copyFileSync(from, to);
    } catch {
      // Keeping the log is a courtesy.
    }
  }
}

/**
 * The data directory. Grade jobs may read it (the manifest, the database)
 * after Sage stops, so it stays until the unit is over and the last one is
 * done.
 */
class DataDirHold {
  private pending: number;
  private finished: boolean;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.pending = 0;
    this.finished = false;
  }

  begin(): void {
    this.pending += 1;
  }

  end(): void {
    this.pending -= 1;
    this.sweep();
  }

  finish(): void {
    this.finished = true;
    this.sweep();
  }

  private sweep(): void {
    if (this.finished && this.pending === 0) {
      rmSync(this.dir, { force: true, recursive: true });
    }
  }
}

interface LoadedModel {
  chat: string;
  contextLength: number;
}

/** Everything one unit shares between its steps. */
interface Unit {
  ctx: RunContext;
  dataDir: string;
  discoveryFile: string;
  first: Setup;
  group: PlanGroup;
  hold: DataDirHold;
  label: string;
  lists: Record<PassName, string[]>;
  /** The model Ollama has loaded for Chat right now. */
  loaded: LoadedModel | null;
  manifestPath: string;
  person: LoadedPerson;
  personFiles: PassFiles;
  setups: Setup[];
}

interface EnvFor {
  files: PassFiles;
  setup: Setup;
  token?: string;
}

function passEnv(unit: Unit, input: EnvFor): Record<string, string> {
  const { ctx, group } = unit;
  const envInput: PassEnvInput = {
    agentDir: ctx.agentDir,
    credentials: ctx.credentials,
    dataDir: unit.dataDir,
    dataRoot: evalDataRoot(),
    discoveryFile: unit.discoveryFile,
    dreamPrompts:
      group.dreamPrompt === baselineDreamPrompt
        ? undefined
        : dreamPromptsDir(repoRoot(), group.dreamPrompt),
    manifest: unit.manifestPath,
    models: {
      chat: input.setup.chatModel,
      embed: input.setup.embedModel,
      summary: input.setup.summaryModel,
    },
    person: unit.person.id,
    repoRoot: repoRoot(),
    results: input.files.results,
    runDir: ctx.runDir,
    setupId: setupIdOf(input.setup),
    sweepFile: ctx.sweepFile,
    sweepId: ctx.sweepId,
    token: input.token,
    transcripts: input.files.transcripts,
  };
  return buildPassEnv(envInput);
}

async function listFor(unit: Unit, pass: PassName): Promise<string[]> {
  const { ctx } = unit;
  const key = `${unit.person.id}|${pass}`;
  const cached = ctx.listCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const command: EvalCommand = {
    agentDir: ctx.agentDir,
    filters: ctx.filters,
    prefixes: ctx.prefixes[pass],
  };
  const listed = await listEvals(
    command,
    passEnv(unit, { files: unit.personFiles, setup: unit.first })
  );
  if (!listed.ok) {
    throw new Error(listed.message);
  }
  ctx.listCache.set(key, listed.ids);
  return listed.ids;
}

function noteOutcome(
  ctx: RunContext,
  label: string,
  outcome: PassOutcome
): void {
  const seconds = (outcome.durationMs / 1000).toFixed(0);
  if (outcome.status === "ok") {
    log(`${label} finished in ${seconds} s`);
  } else if (outcome.status === "evals-failed") {
    ctx.passesWithFailures += 1;
    log(
      `${label} finished in ${seconds} s; some evals failed (see the report)`
    );
  } else {
    fail(ctx, `${label} crashed (exit ${outcome.code}).`);
  }
}

/** Runs one person's unit. A failure is recorded and does not stop the sweep. */
export async function runPersonUnit(
  ctx: RunContext,
  group: PlanGroup,
  personId: string
): Promise<void> {
  const person = ctx.people.get(personId);
  if (person === undefined) {
    fail(ctx, `Unknown person ${personId}.`);
    return;
  }
  const label = `${personId} / mem ${group.memory} / ${group.summaryModel}`;
  try {
    await runUnit(ctx, group, person, label);
  } catch (error) {
    fail(
      ctx,
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runUnit(
  ctx: RunContext,
  group: PlanGroup,
  person: LoadedPerson,
  label: string
): Promise<void> {
  const setups = group.prompts.flatMap((prompt) => prompt.setups);
  const [first] = setups;
  if (first === undefined) {
    throw new Error("This unit has no setups.");
  }
  const dataDir = prepareDataDir(ctx.root);
  const hold = new DataDirHold(dataDir);
  const personFiles = personPassFiles(ctx.runDir, group.dreamKeyId, person.id);
  mkdirSync(personFiles.dir, { recursive: true });
  const unit: Unit = {
    ctx,
    dataDir,
    discoveryFile: join(dataDir, "agent-server.json"),
    first,
    group,
    hold,
    label,
    lists: { chat: [], grade: [], person: [] },
    loaded: null,
    manifestPath: join(dataDir, "manifest.json"),
    person,
    personFiles,
    setups,
  };
  try {
    // What would run? Skip the unit before the first Sage start when nothing
    // matches the filters.
    unit.lists = {
      chat: await listFor(unit, "chat"),
      grade: await listFor(unit, "grade"),
      person: await listFor(unit, "person"),
    };
    const total =
      unit.lists.chat.length +
      unit.lists.grade.length +
      unit.lists.person.length;
    if (total === 0) {
      log(`${label}: no evals match; skipping`);
      return;
    }
    await runWithSage(unit);
  } finally {
    hold.finish();
  }
}

async function dreamKeyOf(unit: Unit): Promise<DreamKey | null> {
  if (!needsDream(unit.person)) {
    return null;
  }
  const { group } = unit;
  return await dreamKeyFor(
    {
      dreamPrompt: group.dreamPrompt,
      embedModel: group.embedModel,
      memory: group.memory,
      person: unit.person,
      summaryModel: group.summaryModel,
    },
    unit.ctx.digests
  );
}

async function runWithSage(unit: Unit): Promise<void> {
  const { ctx, group, label, person } = unit;
  const binary = ctx.builds.get(group.memory);
  if (binary === undefined) {
    throw new Error(`No Sage build for memory ${group.memory}.`);
  }
  const dreamKey = await dreamKeyOf(unit);
  // The snapshot goes in before Sage starts, so Sage opens the restored file.
  const restored =
    dreamKey !== null &&
    restoreSnapshot({
      dataDir: unit.dataDir,
      key: dreamKey.key,
      manifestPath: unit.manifestPath,
    });

  log(`${label}: starting Sage`);
  const sage = await startSage({
    binary,
    dataDir: unit.dataDir,
    dreamPromptsDir:
      group.dreamPrompt === baselineDreamPrompt
        ? undefined
        : dreamPromptsDir(repoRoot(), group.dreamPrompt),
    embedModel: group.embedModel,
    ollamaBin: ctx.ollama.bin,
    summaryModel: group.summaryModel,
  });
  try {
    await seedOrRestore(unit, sage, dreamKey, restored);
    await unloadModel(ctx.ollama.host, group.summaryModel);
    if (unit.lists.person.length > 0 && !ctx.abort.aborted) {
      await runPersonPass(unit);
    }
    if (unit.lists.chat.length > 0) {
      for (const prompt of group.prompts) {
        if (ctx.abort.aborted) {
          break;
        }
        // biome-ignore lint/performance/noAwaitInLoops: one Chat server at a time.
        await runPrompt(unit, prompt.prompt, prompt.setups);
      }
    }
  } finally {
    await stopSage(unit, sage);
  }
  log(`${label}: done with ${person.id}`);
}

async function seedOrRestore(
  unit: Unit,
  sage: SageRun,
  dreamKey: DreamKey | null,
  restored: boolean
): Promise<void> {
  const { ctx, group, label, person } = unit;
  if (restored && dreamKey !== null) {
    log(
      `${label}: using cached Dream artifacts (${dreamKey.key.slice(0, 12)})`
    );
    return;
  }
  log(
    `${label}: ${needsDream(person) ? "seeding and running Dream" : "seeding an empty journal"}`
  );
  await seedPerson({
    automationCwd: sage.automationCwd,
    dataDir: unit.dataDir,
    logFile: join(unit.personFiles.dir, "seed.log"),
    manifestPath: unit.manifestPath,
    personId: person.id,
    root: ctx.root,
  });
  if (dreamKey !== null) {
    snapshotDream({
      dataDir: unit.dataDir,
      dreamPrompt: group.dreamPrompt,
      key: dreamKey,
      manifestPath: unit.manifestPath,
    });
  }
}

/** Stops Sage, keeps its log and manifest, and waits for its Ollama to go. */
async function stopSage(unit: Unit, sage: SageRun): Promise<void> {
  const { ctx, group, person } = unit;
  if (unit.loaded !== null) {
    await unloadModel(ctx.ollama.host, unit.loaded.chat);
    unit.loaded = null;
  }
  await sage.stop();
  const stem = `${ctx.sweepId}__${group.dreamKeyId}__${person.id}`;
  copyIfPresent(sage.logFile, join(ctx.reportsDir, `${stem}.sage.log`));
  copyIfPresent(
    unit.manifestPath,
    join(ctx.reportsDir, `${stem}.manifest.json`)
  );
  await waitForOllamaGone(ctx.ollama.host);
}

/** One Chat server from one overlay, then each of the prompt's setups in order. */
async function runPrompt(
  unit: Unit,
  promptName: string,
  setups: readonly Setup[]
): Promise<void> {
  const { ctx } = unit;
  const overlay = ctx.overlays.get(promptName);
  if (overlay === undefined) {
    throw new Error(`No overlay for Chat prompt ${promptName}.`);
  }
  const server = await startEveServer({
    agentDir: ctx.agentDir,
    discoveryFile: unit.discoveryFile,
    logFile: join(unit.personFiles.dir, `eve-${promptName}.log`),
    ollamaBaseUrl: ollamaApiBase(ctx.ollama.host),
    root: overlay.root,
    withWorkflowGuard: true,
  });
  try {
    const token = readServerToken(unit.discoveryFile);
    for (const setup of setups) {
      if (ctx.abort.aborted) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: setups run one after another; local generation never overlaps.
      await runSetup(unit, setup, server.url, token);
    }
  } finally {
    await server.stop();
  }
}

async function runSetup(
  unit: Unit,
  setup: Setup,
  serverUrl: string,
  token: string
): Promise<void> {
  const { ctx, label, person } = unit;
  if (setup.thinking === "on" && ctx.cannotThink.has(setup.chatModel)) {
    log(`${label}: ${setup.chatModel} cannot think; skipping think-on`);
    return;
  }
  await prepareModel(unit, setup);
  const id = setupIdOf(setup);
  const files = setupPassFiles(ctx.runDir, id, person.id, "chat");
  mkdirSync(files.dir, { recursive: true });
  const outcome = await runEvalPass(
    {
      agentDir: ctx.agentDir,
      concurrency: PASS_CONCURRENCY.chat,
      filters: ctx.filters,
      prefixes: ctx.prefixes.chat,
      url: serverUrl,
    },
    {
      echoPrefix: `[chat ${person.id} ${id}]`,
      env: passEnv(unit, { files, setup, token }),
      logFile: files.log,
      secrets: [token],
    }
  );
  noteOutcome(ctx, `${label}: chat ${setupLabel(setup)}`, outcome);
  if (unit.lists.grade.length > 0) {
    unit.hold.begin();
    await ctx.pool.submit(async () => {
      try {
        await runGrade(unit, setup);
      } finally {
        unit.hold.end();
      }
    });
  }
}

/** Loads the model the setup needs, and unloads the one it replaces. */
async function prepareModel(unit: Unit, setup: Setup): Promise<void> {
  const { loaded } = unit;
  if (
    loaded !== null &&
    loaded.chat === setup.chatModel &&
    loaded.contextLength === setup.contextLength
  ) {
    return;
  }
  const { host } = unit.ctx.ollama;
  if (loaded !== null && loaded.chat !== setup.chatModel) {
    await unloadModel(host, loaded.chat);
  }
  await warmUpModel(host, setup.chatModel, setup.contextLength);
  unit.loaded = { chat: setup.chatModel, contextLength: setup.contextLength };
}

async function runPersonPass(unit: Unit): Promise<void> {
  const { ctx, label, person } = unit;
  const outcome = await runEvalPass(
    {
      agentDir: ctx.agentDir,
      concurrency: PASS_CONCURRENCY.person,
      filters: ctx.filters,
      prefixes: ctx.prefixes.person,
      url: ctx.stubUrl,
    },
    {
      echoPrefix: `[person ${person.id}]`,
      env: passEnv(unit, { files: unit.personFiles, setup: unit.first }),
      logFile: unit.personFiles.log,
    }
  );
  noteOutcome(ctx, `${label}: person checks`, outcome);
}

async function runGrade(unit: Unit, setup: Setup): Promise<void> {
  const { ctx, label, person } = unit;
  // The grade pass reads the transcripts file the chat pass wrote, which sits
  // beside its own results file.
  const files = setupPassFiles(
    ctx.runDir,
    setupIdOf(setup),
    person.id,
    "grade"
  );
  const outcome = await runEvalPass(
    {
      agentDir: ctx.agentDir,
      concurrency: PASS_CONCURRENCY.grade,
      filters: ctx.filters,
      prefixes: ctx.prefixes.grade,
      url: ctx.stubUrl,
    },
    {
      env: passEnv(unit, { files, setup }),
      logFile: files.log,
    }
  );
  noteOutcome(ctx, `${label}: grade ${setupLabel(setup)}`, outcome);
}
