// One person under one Dream snapshot: the unit the runner repeats.
//
// A unit starts one Sage (and so one Ollama) with the person's journal,
// restores or builds the Dream snapshot, runs the person pass, then walks the
// Chat prompts, chat models, context lengths, and thinking values. Each setup
// gets a generation pass here and a grade pass in the background.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { baselineDreamPrompt, dreamPromptsDir, repoRoot } from "../../evals/lib/cache.ts";
import { evalDataRoot } from "../../evals/lib/dataset.ts";
import {
  dreamKeyId,
  type Memory,
  type Setup,
  setupId as setupIdOf,
  type SweepFile,
} from "../../evals/lib/schema.ts";
import type { CostMeter } from "./cost.ts";
import {
  type DreamKey,
  dreamKeyFor,
  needsDream,
  restoreSnapshot,
  seedPerson,
  snapshotDream,
} from "./dream.ts";
import { readServerToken, startEveServer } from "./eve.ts";
import {
  personPassFiles,
  type PassFiles,
  setupPassFiles,
} from "./collect.ts";
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
import type { PassName, PlanGroup, PassPrefixes } from "./plan.ts";
import type { LoadedPerson } from "./people.ts";
import { prepareDataDir, startSage } from "./sage.ts";

export interface RunContext {
  abort: { aborted: boolean };
  agentDir: string;
  builds: ReadonlyMap<Memory, string>;
  /** Chat models that cannot think. Their think-on setups do not run. */
  cannotThink: ReadonlySet<string>;
  credentials: Record<string, string>;
  /** Problems the run met, for the exit code and the summary. */
  failures: string[];
  /** Eve filters from ARGS. */
  filters: readonly string[];
  /** Evals each pass listed, by person and pass, so the list runs once. */
  listCache: Map<string, string[]>;
  meter: CostMeter | null;
  ollama: { bin: string; host: string };
  /** The `--url` of the stub target for the person and grade passes. */
  stubUrl: string;
  overlays: ReadonlyMap<string, Overlay>;
  /** Passes that exited with a failed eval. This sets the exit code. */
  passesWithFailures: number;
  people: ReadonlyMap<string, LoadedPerson>;
  pool: JobPool;
  prefixes: PassPrefixes;
  reportsDir: string;
  root: string;
  runDir: string;
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

interface EnvFor {
  dataDir: string;
  discoveryFile: string;
  dreamPromptName: string;
  files: PassFiles;
  manifest: string;
  person: string;
  setup: Setup;
  token?: string;
}

function passEnv(ctx: RunContext, input: EnvFor): Record<string, string> {
  const envInput: PassEnvInput = {
    agentDir: ctx.agentDir,
    credentials: ctx.credentials,
    dataDir: input.dataDir,
    dataRoot: evalDataRoot(),
    discoveryFile: input.discoveryFile,
    dreamPrompts:
      input.dreamPromptName === baselineDreamPrompt
        ? undefined
        : dreamPromptsDir(repoRoot(), input.dreamPromptName),
    manifest: input.manifest,
    models: {
      chat: input.setup.chatModel,
      embed: input.setup.embedModel,
      summary: input.setup.summaryModel,
    },
    person: input.person,
    repoRoot: repoRoot(),
    results: input.files.results,
    runDir: ctx.runDir,
    setupId: setupIdOf(input.setup),
    sweepFile: ctx.sweepFile,
    token: input.token,
    transcripts: input.files.transcripts,
  };
  return buildPassEnv(envInput);
}

async function listFor(
  ctx: RunContext,
  pass: PassName,
  person: string,
  env: Record<string, string>
): Promise<string[]> {
  const key = `${person}|${pass}`;
  const cached = ctx.listCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const command: EvalCommand = {
    agentDir: ctx.agentDir,
    filters: ctx.filters,
    prefixes: ctx.prefixes[pass],
  };
  const listed = await listEvals(command, env);
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
    log(`${label} finished in ${seconds} s; some evals failed (see the report)`);
  } else {
    fail(ctx, `${label} crashed (exit ${outcome.code}).`);
  }
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
  const first = setups[0];
  const binary = ctx.builds.get(group.memory);
  if (first === undefined || binary === undefined) {
    throw new Error("No setups or no Sage build for this unit.");
  }
  const dataDir = prepareDataDir(ctx.root);
  const manifestPath = join(dataDir, "manifest.json");
  const discoveryFile = join(dataDir, "agent-server.json");
  const personFiles = personPassFiles(ctx.runDir, group.dreamKeyId, person.id);
  mkdirSync(personFiles.dir, { recursive: true });

  // What would run? Skip the unit before the first Sage start when nothing
  // matches the filters.
  const listEnv = passEnv(ctx, {
    dataDir,
    discoveryFile,
    dreamPromptName: group.dreamPrompt,
    files: personFiles,
    manifest: manifestPath,
    person: person.id,
    setup: first,
  });
  const lists = {
    chat: await listFor(ctx, "chat", person.id, listEnv),
    grade: await listFor(ctx, "grade", person.id, listEnv),
    person: await listFor(ctx, "person", person.id, listEnv),
  };
  if (lists.chat.length + lists.grade.length + lists.person.length === 0) {
    log(`${label}: no evals match; skipping`);
    rmSync(dataDir, { force: true, recursive: true });
    return;
  }

  // Grade jobs may read the data directory (the manifest, the database) after
  // Sage stops, so the directory stays until the last one is done.
  let pendingGrades = 0;
  let unitDone = false;
  const removeDataDir = (): void => {
    if (unitDone && pendingGrades === 0) {
      rmSync(dataDir, { force: true, recursive: true });
    }
  };

  const unit = {
    dreamPrompt: group.dreamPrompt,
    embedModel: group.embedModel,
    memory: group.memory,
    person,
    summaryModel: group.summaryModel,
  };
  let dreamKey: DreamKey | null = null;
  let restored = false;
  if (needsDream(person)) {
    dreamKey = await dreamKeyFor(unit, ctx.ollama.host);
    restored = restoreSnapshot({
      dataDir,
      key: dreamKey.key,
      manifestPath,
    });
  }

  log(`${label}: starting Sage`);
  const sage = await startSage({
    binary,
    dataDir,
    dreamPromptsDir:
      group.dreamPrompt === baselineDreamPrompt
        ? undefined
        : dreamPromptsDir(repoRoot(), group.dreamPrompt),
    embedModel: group.embedModel,
    ollamaBin: ctx.ollama.bin,
    summaryModel: group.summaryModel,
  });
  let currentModel: { chat: string; contextLength: number } | null = null;
  try {
    if (restored && dreamKey !== null) {
      log(`${label}: using cached Dream artifacts (${dreamKey.key.slice(0, 12)})`);
    } else {
      log(
        `${label}: ${needsDream(person) ? "seeding and running Dream" : "seeding an empty journal"}`
      );
      await seedPerson({
        automationCwd: sage.automationCwd,
        dataDir,
        logFile: join(personFiles.dir, "seed.log"),
        manifestPath,
        personId: person.id,
        root: ctx.root,
      });
      if (dreamKey !== null) {
        snapshotDream({
          dataDir,
          dreamPrompt: group.dreamPrompt,
          key: dreamKey,
          manifestPath,
        });
      }
    }
    await unloadModel(ctx.ollama.host, group.summaryModel);

    if (lists.person.length > 0 && !ctx.abort.aborted) {
      await runPersonPass(ctx, {
        dataDir,
        discoveryFile,
        files: personFiles,
        group,
        label,
        manifestPath,
        person,
        setups,
      });
    }

    if (lists.chat.length > 0) {
      for (const prompt of group.prompts) {
        if (ctx.abort.aborted) {
          break;
        }
        const overlay = ctx.overlays.get(prompt.prompt);
        if (overlay === undefined) {
          throw new Error(`No overlay for Chat prompt ${prompt.prompt}.`);
        }
        const server = await startEveServer({
          agentDir: ctx.agentDir,
          discoveryFile,
          logFile: join(personFiles.dir, `eve-${prompt.prompt}.log`),
          ollamaBaseUrl: ollamaApiBase(ctx.ollama.host),
          root: overlay.root,
          withWorkflowGuard: true,
        });
        // The overlay keeps its build cache between people, but its sessions
        // belong to one server.
        const token = readServerToken(discoveryFile);
        try {
          for (const setup of prompt.setups) {
            if (ctx.abort.aborted) {
              break;
            }
            if (setup.thinking === "on" && ctx.cannotThink.has(setup.chatModel)) {
              log(`${label}: ${setup.chatModel} cannot think; skipping think-on`);
              continue;
            }
            currentModel = await prepareModel(ctx, currentModel, setup);
            const files = setupPassFiles(
              ctx.runDir,
              setupIdOf(setup),
              person.id,
              "chat"
            );
            mkdirSync(files.dir, { recursive: true });
            const outcome = await runEvalPass(
              {
                agentDir: ctx.agentDir,
                concurrency: PASS_CONCURRENCY.chat,
                filters: ctx.filters,
                prefixes: ctx.prefixes.chat,
                url: server.url,
              },
              {
                echoPrefix: `[chat ${person.id} ${setupIdOf(setup)}]`,
                env: passEnv(ctx, {
                  dataDir,
                  discoveryFile,
                  dreamPromptName: setup.dreamPrompt,
                  files,
                  manifest: manifestPath,
                  person: person.id,
                  setup,
                  token,
                }),
                logFile: files.log,
                secrets: [token],
              }
            );
            noteOutcome(ctx, `${label}: chat ${setupLabel(setup)}`, outcome);
            if (lists.grade.length > 0) {
              pendingGrades += 1;
              await ctx.pool.submit(async () => {
                try {
                  await runGrade(ctx, {
                    dataDir,
                    discoveryFile,
                    label,
                    manifestPath,
                    person,
                    setup,
                  });
                } finally {
                  pendingGrades -= 1;
                  removeDataDir();
                }
              });
            }
          }
        } finally {
          await server.stop();
        }
      }
    }
  } finally {
    if (currentModel !== null) {
      await unloadModel(ctx.ollama.host, currentModel.chat);
    }
    await sage.stop();
    copyIfPresent(
      sage.logFile,
      join(ctx.reportsDir, `${ctx.sweepId}__${group.dreamKeyId}__${person.id}.sage.log`)
    );
    copyIfPresent(
      manifestPath,
      join(
        ctx.reportsDir,
        `${ctx.sweepId}__${group.dreamKeyId}__${person.id}.manifest.json`
      )
    );
    try {
      await waitForOllamaGone(ctx.ollama.host);
    } finally {
      unitDone = true;
      removeDataDir();
    }
  }
}

function setupLabel(setup: Setup): string {
  return `${setup.chatModel} / ${setup.prompt} / think ${setup.thinking} / ctx ${setup.contextLength}`;
}

/** Loads the model the setup needs, and unloads the one it replaces. */
async function prepareModel(
  ctx: RunContext,
  current: { chat: string; contextLength: number } | null,
  setup: Setup
): Promise<{ chat: string; contextLength: number }> {
  if (
    current !== null &&
    current.chat === setup.chatModel &&
    current.contextLength === setup.contextLength
  ) {
    return current;
  }
  if (current !== null && current.chat !== setup.chatModel) {
    await unloadModel(ctx.ollama.host, current.chat);
  }
  await warmUpModel(ctx.ollama.host, setup.chatModel, setup.contextLength);
  return { chat: setup.chatModel, contextLength: setup.contextLength };
}

async function runPersonPass(
  ctx: RunContext,
  input: {
    dataDir: string;
    discoveryFile: string;
    files: PassFiles;
    group: PlanGroup;
    label: string;
    manifestPath: string;
    person: LoadedPerson;
    setups: Setup[];
  }
): Promise<void> {
  const [first] = input.setups;
  if (first === undefined) {
    return;
  }
  const job = `person:${input.group.dreamKeyId}:${input.person.id}`;
  ctx.meter?.start(job, input.setups.map((setup) => setupIdOf(setup)));
  try {
    const outcome = await runEvalPass(
      {
        agentDir: ctx.agentDir,
        concurrency: PASS_CONCURRENCY.person,
        filters: ctx.filters,
        prefixes: ctx.prefixes.person,
        url: ctx.stubUrl,
      },
      {
        echoPrefix: `[person ${input.person.id}]`,
        env: passEnv(ctx, {
          dataDir: input.dataDir,
          discoveryFile: input.discoveryFile,
          dreamPromptName: input.group.dreamPrompt,
          files: input.files,
          manifest: input.manifestPath,
          person: input.person.id,
          setup: first,
        }),
        logFile: input.files.log,
      }
    );
    noteOutcome(ctx, `${input.label}: person checks`, outcome);
  } finally {
    ctx.meter?.end(job);
  }
}

async function runGrade(
  ctx: RunContext,
  input: {
    dataDir: string;
    discoveryFile: string;
    label: string;
    manifestPath: string;
    person: LoadedPerson;
    setup: Setup;
  }
): Promise<void> {
  const id = setupIdOf(input.setup);
  const files = setupPassFiles(ctx.runDir, id, input.person.id, "grade");
  const job = `grade:${id}:${input.person.id}`;
  ctx.meter?.start(job, [id]);
  try {
    const outcome = await runEvalPass(
      {
        agentDir: ctx.agentDir,
        concurrency: PASS_CONCURRENCY.grade,
        filters: ctx.filters,
        prefixes: ctx.prefixes.grade,
        url: ctx.stubUrl,
      },
      {
        env: passEnv(ctx, {
          dataDir: input.dataDir,
          discoveryFile: input.discoveryFile,
          dreamPromptName: input.setup.dreamPrompt,
          files: {
            ...files,
            // The grade pass reads the transcripts the chat pass wrote.
            transcripts: setupPassFiles(ctx.runDir, id, input.person.id, "chat")
              .transcripts,
          },
          manifest: input.manifestPath,
          person: input.person.id,
          setup: input.setup,
        }),
        logFile: files.log,
      }
    );
    noteOutcome(ctx, `${input.label}: grade ${setupLabel(input.setup)}`, outcome);
  } finally {
    ctx.meter?.end(job);
  }
}

/** The Dream key id, for callers that group by it. */
export function groupKeyOf(setup: Setup): string {
  return dreamKeyId(setup);
}
