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
  cachedDreamEntry,
  dreamPromptsDir,
  evalCacheDir,
  evalCacheEnabled,
  repoRoot,
} from "../../evals/lib/cache.ts";
import { evalDataRoot } from "../../evals/lib/dataset.ts";
import {
  type Memory,
  type Setup,
  type SweepFile,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import { type ChatDay, rewriteChatTimes } from "./chat-times.ts";
import {
  type PassFiles,
  personPassFiles,
  recordSetupFailure,
  setupPassFiles,
} from "./collect.ts";
import {
  type DigestLookup,
  type DreamKey,
  dreamKeyFor,
  needsDream,
  restoreSnapshot,
  type SeedOptions,
  seededChatDays,
  seedPerson,
  seedsInStages,
  snapshotDream,
} from "./dream.ts";
import { withoutSecrets } from "./env.ts";
import { readServerToken, startEveServer } from "./eve.ts";
import {
  appendMemoryReading,
  type MemoryProbes,
  measureMemory,
} from "./memory-pressure.ts";
import {
  ollamaApiBase,
  runningModels,
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
import {
  DREAM_ACCURACY_EVAL,
  type PassName,
  type PassPrefixes,
  type PlanGroup,
} from "./plan.ts";
import { captureCommand } from "./proc.ts";
import {
  createProgress,
  type Progress,
  pendingWork,
  type Step,
  savedManifestPath,
} from "./resume.ts";
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
  /** Stand-ins for the two steps that need a real Sage build. Tests set them. */
  hooks?: {
    automateWait?: (cwd: string) => Promise<boolean>;
    /** What the memory monitor looks at. Defaults to `sysctl vm.swapusage` and Ollama's `/api/ps`. */
    memoryProbes?: MemoryProbes;
    /** Moves seeded past chats to their own days. Defaults to `rewriteChatTimes`. */
    rewriteChatTimes?: (dbPath: string, chats: readonly ChatDay[]) => void;
    seed?: (options: SeedOptions) => Promise<void>;
  };
  /** Evals each pass listed, by person and pass, so the list runs once. */
  listCache: Map<string, string[]>;
  ollama: { bin: string; host: string };
  overlays: ReadonlyMap<string, Overlay>;
  /** Passes that exited with a failed eval. This sets the exit code. */
  passesWithFailures: number;
  people: ReadonlyMap<string, LoadedPerson>;
  pool: JobPool;
  prefixes: PassPrefixes;
  /** Which steps are done, for `--resume`. Defaults to the markers in `runDir`. */
  progress?: Progress;
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

/** The real probes: `sysctl vm.swapusage`, and the models the setup's Ollama has loaded. */
function realMemoryProbes(ollamaHost: string): MemoryProbes {
  return {
    loadedModels: () => runningModels(ollamaHost),
    swapUsage: async () => {
      const result = await captureCommand("sysctl", ["vm.swapusage"], {
        env: withoutSecrets(),
        timeoutMs: 5000,
      });
      return result.code === 0 ? result.stdout : null;
    },
  };
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
  /** The key of the person's Dream snapshot. Null for an empty journal. */
  dreamKey: string | null;
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
  progress: Progress;
  setups: Setup[];
}

interface EnvFor {
  /** The key of the person's Dream snapshot. Only the person pass gets it. */
  dreamKey?: string;
  files: PassFiles;
  setup: Setup;
  token?: string;
}

function passEnv(unit: Unit, input: EnvFor): Record<string, string> {
  const { ctx } = unit;
  const envInput: PassEnvInput = {
    agentDir: ctx.agentDir,
    credentials: ctx.credentials,
    dataDir: unit.dataDir,
    dataRoot: evalDataRoot(),
    discoveryFile: unit.discoveryFile,
    dreamKey: input.dreamKey,
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
    dreamKey: null,
    first,
    group,
    hold,
    label,
    lists: { chat: [], grade: [], person: [] },
    loaded: null,
    manifestPath: join(dataDir, "manifest.json"),
    person,
    personFiles,
    progress: ctx.progress ?? createProgress(ctx.runDir),
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
    const pending = pendingWork(unit.progress, {
      dreamKeyId: group.dreamKeyId,
      lists: {
        chat: unit.lists.chat.length,
        grade: unit.lists.grade.length,
        person: unit.lists.person.length,
      },
      person: person.id,
      setupIds: setups.filter((setup) => runnable(unit, setup)).map(setupIdOf),
    });
    if (!(pending.chat || pending.grade || pending.person)) {
      log(`${label}: finished in an earlier run; skipping`);
      return;
    }
    // With only grading left, Sage is not needed: the replies are saved, and
    // so is the manifest the search checks read.
    if (
      !(pending.chat || pending.person) &&
      existsSync(savedManifestPath(ctx.runDir, group.dreamKeyId, person.id))
    ) {
      await runGradeOnly(unit);
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
  unit.dreamKey = dreamKey?.key ?? null;
  // The snapshot goes in before Sage starts, so Sage opens the restored file.
  const restored =
    dreamKey !== null &&
    restoreSnapshot({
      dataDir: unit.dataDir,
      key: dreamKey.key,
      manifestPath: unit.manifestPath,
    });

  log(`${label}: starting Sage`);
  const running: RunningSage = { sage: await startUnitSage(unit, binary) };
  try {
    await seedOrRestore(unit, running, binary, dreamKey, restored);
    // A later run that has only grading left reads this copy, and starts no Sage.
    copyIfPresent(
      unit.manifestPath,
      savedManifestPath(ctx.runDir, group.dreamKeyId, person.id)
    );
    await unloadModel(ctx.ollama.host, group.summaryModel);
    if (
      unit.lists.person.length > 0 &&
      !ctx.abort.aborted &&
      !unit.progress.isDone(personStep(unit))
    ) {
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
    await stopSage(unit, running.sage);
  }
  log(`${label}: done with ${person.id}`);
}

function personStep(unit: Unit): Step {
  return {
    dreamKeyId: unit.group.dreamKeyId,
    kind: "person",
    person: unit.person.id,
  };
}

function chatStep(unit: Unit, setup: Setup): Step {
  return { kind: "chat", person: unit.person.id, setupId: setupIdOf(setup) };
}

function gradeStep(unit: Unit, setup: Setup): Step {
  return { kind: "grade", person: unit.person.id, setupId: setupIdOf(setup) };
}

/** False for a think-on setup of a model that cannot think. It never runs. */
function runnable(unit: Unit, setup: Setup): boolean {
  return !(
    setup.thinking === "on" && unit.ctx.cannotThink.has(setup.chatModel)
  );
}

/** True when a pass ended with rows to keep: it did not crash, and the run was not stopped. */
function finishedCleanly(unit: Unit, outcome: PassOutcome): boolean {
  return outcome.status !== "crashed" && !unit.ctx.abort.aborted;
}

/** Grades the setups whose replies an earlier run saved. Starts no Sage. */
async function runGradeOnly(unit: Unit): Promise<void> {
  const { ctx, group, label, person } = unit;
  unit.manifestPath = savedManifestPath(
    ctx.runDir,
    group.dreamKeyId,
    person.id
  );
  log(`${label}: only grading is left, so Sage does not start`);
  for (const setup of unit.setups) {
    if (ctx.abort.aborted) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: the pool takes one job at a time.
    await gradeIfPending(unit, setup);
  }
}

/** Hands the grade pass of a setup to the pool, unless an earlier run finished it. */
async function gradeIfPending(unit: Unit, setup: Setup): Promise<void> {
  if (
    !runnable(unit, setup) ||
    unit.lists.grade.length === 0 ||
    unit.progress.isDone(gradeStep(unit, setup))
  ) {
    return;
  }
  unit.hold.begin();
  await unit.ctx.pool.submit(async () => {
    try {
      await runGrade(unit, setup);
    } finally {
      unit.hold.end();
    }
  });
}

/** The Sage of a unit. Seeding a person with past chats stops it and starts another. */
interface RunningSage {
  sage: SageRun;
}

function startUnitSage(unit: Unit, binary: string): Promise<SageRun> {
  const { ctx, group } = unit;
  return startSage({
    automateWait: ctx.hooks?.automateWait,
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
}

function seedOptionsFor(
  unit: Unit,
  sage: SageRun,
  stage?: SeedOptions["stage"]
): SeedOptions {
  return {
    automationCwd: sage.automationCwd,
    dataDir: unit.dataDir,
    logFile: join(unit.personFiles.dir, "seed.log"),
    manifestPath: unit.manifestPath,
    personId: unit.person.id,
    root: unit.ctx.root,
    ...(stage === undefined ? {} : { stage }),
  };
}

/**
 * Saves a person's past chats, then moves them to their own days, then runs
 * Dream. Sage stamps a saved chat with the real clock, and Dream reads a
 * chat's date from that stamp, so the days are fixed before Dream starts. Only
 * a stopped Sage's database is written, so Sage stops in between and a new one
 * takes its place.
 */
async function seedWithChats(
  unit: Unit,
  running: RunningSage,
  binary: string
): Promise<void> {
  const { ctx, label, person } = unit;
  const seed = ctx.hooks?.seed ?? seedPerson;
  await seed(seedOptionsFor(unit, running.sage, "content"));
  log(`${label}: moving ${person.chats.length} past chats to their own days`);
  await stopSage(unit, running.sage);
  const days = seededChatDays(person, unit.manifestPath);
  (ctx.hooks?.rewriteChatTimes ?? rewriteChatTimes)(
    join(unit.dataDir, "app.db"),
    days
  );
  running.sage = await startUnitSage(unit, binary);
  await seed(seedOptionsFor(unit, running.sage, "dream"));
}

async function seedOrRestore(
  unit: Unit,
  running: RunningSage,
  binary: string,
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
  if (seedsInStages(person)) {
    await seedWithChats(unit, running, binary);
  } else {
    await (ctx.hooks?.seed ?? seedPerson)(seedOptionsFor(unit, running.sage));
  }
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
  // Setups whose replies an earlier run saved need no Chat server. They only
  // need grading, if that did not finish either.
  const pending: Setup[] = [];
  for (const setup of setups) {
    if (unit.progress.isDone(chatStep(unit, setup))) {
      // biome-ignore lint/performance/noAwaitInLoops: the pool takes one job at a time.
      await gradeIfPending(unit, setup);
    } else {
      pending.push(setup);
    }
  }
  if (pending.every((setup) => !runnable(unit, setup))) {
    return;
  }
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
    for (const setup of pending) {
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
  const id = setupIdOf(setup);
  // From scratch: whatever a killed pass left behind is deleted first. The
  // transcripts are appended to, so rows from before would be written twice.
  unit.progress.reset(chatStep(unit, setup));
  const files = setupPassFiles(ctx.runDir, id, person.id, "chat");
  mkdirSync(files.dir, { recursive: true });
  const state = { finished: false };
  // Memory is watched from the model load to the end of the replies. The
  // grade pass talks to the cloud, so it is not part of what must fit.
  const generated = await measureMemory(
    ctx.hooks?.memoryProbes ?? realMemoryProbes(ctx.ollama.host),
    async () => {
      try {
        await prepareModel(unit, setup);
      } catch (error) {
        // One model that will not load (too big for this Mac, say) must not
        // end the other setups of the unit. The report shows it as a failed
        // turn.
        if (!ctx.abort.aborted) {
          const message =
            error instanceof Error ? error.message : String(error);
          recordSetupFailure(files.results, {
            message,
            person: person.id,
            setupId: id,
          });
          fail(
            ctx,
            `${label}: chat ${setupLabel(setup)} could not start: ${message}`
          );
        }
        return false;
      }
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
      state.finished = finishedCleanly(unit, outcome);
      return true;
    },
    {
      onReading: (reading) =>
        appendMemoryReading(ctx.runDir, id, person.id, reading),
    }
  );
  if (generated && state.finished) {
    unit.progress.markDone(chatStep(unit, setup));
    await gradeIfPending(unit, setup);
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
  // Whatever happens next, the model that was loaded is gone or about to be.
  unit.loaded = null;
  await warmUpModel(host, setup.chatModel, setup.contextLength);
  unit.loaded = { chat: setup.chatModel, contextLength: setup.contextLength };
}

/**
 * Dream accuracy keeps its grades in the snapshot's folder
 * (`agent/evals/.cache/dream/<key>/`), and never makes that folder: the folder
 * holds the snapshot, and the snapshot is moved into place whole. So the
 * runner does not make it either. A snapshot that was not saved leaves no
 * folder, and a folder holding only grades would make the next snapshot of
 * this key fail. The grades are then not kept, and the next run grades again.
 * The runner says so in that case, and when the cache is off.
 */
function noteGradeCache(unit: Unit): void {
  if (
    unit.dreamKey === null ||
    !unit.ctx.prefixes.person.includes(DREAM_ACCURACY_EVAL)
  ) {
    return;
  }
  if (!evalCacheEnabled()) {
    log(
      `${unit.label}: the cache is off (SAGE_EVAL_CACHE=0), so the Dream accuracy grades will not be kept`
    );
    return;
  }
  if (cachedDreamEntry(unit.dreamKey, evalCacheDir()) === null) {
    log(
      `${unit.label}: the Dream snapshot was not saved, so the Dream accuracy grades will not be kept`
    );
  }
}

async function runPersonPass(unit: Unit): Promise<void> {
  const { ctx, label, person } = unit;
  noteGradeCache(unit);
  // From scratch, as the chat pass is: its results file is appended to.
  unit.progress.reset(personStep(unit));
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
      env: passEnv(unit, {
        dreamKey: unit.dreamKey ?? undefined,
        files: unit.personFiles,
        setup: unit.first,
      }),
      logFile: unit.personFiles.log,
    }
  );
  noteOutcome(ctx, `${label}: person checks`, outcome);
  if (finishedCleanly(unit, outcome)) {
    unit.progress.markDone(personStep(unit));
  }
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
  // Grades start from scratch too. Its results file is appended to.
  unit.progress.reset(gradeStep(unit, setup));
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
  if (finishedCleanly(unit, outcome)) {
    unit.progress.markDone(gradeStep(unit, setup));
  }
}
