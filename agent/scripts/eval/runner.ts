// `make eval`: runs a sweep file.
//
//   node --experimental-strip-types agent/scripts/eval/run.ts [--sweep <name>] [--dry-run] [--yes] [eve filters]
//
// Replaces scripts/eval-run.sh. The run goes in stages: plan, check the
// simulated user (when the sweep runs conversations), check the Chat prompts
// and the grade target, check the models and print the estimate, ask, pull,
// build, run, and write the reports. `--dry-run` stops after the estimate.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  cachedDreamEntry,
  evalCacheDir,
  evalCacheEnabled,
  readDreamPrompts,
  repoRoot,
} from "../../evals/lib/cache.ts";
import { priceCacheFile } from "../../evals/lib/prices.ts";
import {
  dreamKeyId,
  type Memory,
  type Setup,
  type SetupReport,
  type SweepSummary,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import { CliError, type CliOptions, parseCli, USAGE } from "./cli.ts";
import {
  DEFAULT_PRICE,
  DEFAULT_SIMULATED_USER_PRICE,
  loadPriceBook,
  simulatedUserProblem,
  spentUsd,
} from "./cloud.ts";
import { collectSetupData } from "./collect.ts";
import {
  type DigestLookup,
  dreamKeyFor,
  dreamPromptProblems,
  needsDream,
  snapshotDigests,
} from "./dream.ts";
import {
  gatewayCredentials,
  loadEvalEnv,
  uploadEnv,
  withoutSecrets,
} from "./env.ts";
import {
  dreamMissKey,
  type Estimate,
  estimateRun,
  formatEstimate,
  loadTimingHistory,
} from "./estimate.ts";
import { EVAL_TODAY, type EveServer, startEveServer } from "./eve.ts";
import { judgeCheckSize, runJudgeCheck } from "./judge-check.ts";
import { readSwapReading } from "./memory-pressure.ts";
import {
  checkModels,
  fetchPinnedOllama,
  type ModelCheck,
  OLLAMA_HOST,
  ollamaApiBase,
  type PullServer,
  pullModel,
  startPullServer,
} from "./ollama.ts";
import {
  buildOverlay,
  buildTargetRoot,
  liveToolNames,
  type Overlay,
  sha12,
  verifyRoot,
} from "./overlay.ts";
import { credentialsFrom, JobPool, MAX_GRADE_PROCESSES } from "./passes.ts";
import {
  dataProblems,
  type LoadedPerson,
  loadAllPeople,
  selectPeople,
} from "./people.ts";
import {
  buildPlan,
  describePlan,
  distinct,
  needsChat,
  type ResolvedTests,
  type RunPlan,
  resolveTests,
  runsConversations,
} from "./plan.ts";
import { captureCommand, killAllTracked, terminateAllTracked } from "./proc.ts";
import {
  assembleSetupReport,
  assembleSweepSummary,
  describeRanking,
  writeReports,
} from "./report.ts";
import { buildSage, removeBuilds } from "./sage.ts";
import {
  type LoadedSweep,
  loadSweep,
  makeSweepId,
  resolvedSweepJson,
} from "./sweep.ts";
import { type RunContext, runPersonUnit } from "./unit.ts";

const trailingSlashPattern = /\/$/u;
const agentDir = fileURLToPath(new URL("../..", import.meta.url)).replace(
  trailingSlashPattern,
  ""
);
const root = dirname(agentDir);

/** How long the children get to stop on the first Ctrl-C before they are ended. */
const SIGNAL_GRACE_MS = 5000;

function log(message: string): void {
  console.log(message);
}

function heading(message: string): void {
  console.log(`\n== ${message}`);
}

function statusLine(label: string, items: readonly string[]): void {
  if (items.length > 0) {
    log(`${label}: ${items.join(", ")}`);
  }
}

/** Ends the run with a message and an exit code. Thrown from any stage. */
class Stop extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "Stop";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function gitCommit(): Promise<string> {
  const env = withoutSecrets();
  const head = await captureCommand("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    env,
  });
  if (head.code !== 0) {
    return "unknown";
  }
  const status = await captureCommand("git", ["status", "--porcelain"], {
    cwd: root,
    env,
  });
  const dirty = status.code === 0 && status.stdout.trim().length > 0;
  return `${head.stdout.trim()}${dirty ? "+dirty" : ""}`;
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** The models the setups use, by role. With no Chat in the sweep, no chat model is used. */
function modelRoles(setups: readonly Setup[], chat = true) {
  return {
    chat: chat ? distinct(setups, "chatModel") : [],
    embed: distinct(setups, "embedModel"),
    summary: distinct(setups, "summaryModel"),
  };
}

/** Every model the setups use, once each. */
function modelsOf(setups: readonly Setup[], chat = true): string[] {
  const roles = modelRoles(setups, chat);
  return [...new Set([...roles.summary, ...roles.embed, ...roles.chat])];
}

/** Drops think-on setups for models that cannot think. */
function withoutImpossibleThinking(
  setups: readonly Setup[],
  cannotThink: ReadonlySet<string>
): Setup[] {
  return setups.filter(
    (setup) => !(setup.thinking === "on" && cannotThink.has(setup.chatModel))
  );
}

function promptShasFor(
  setup: Setup,
  overlays: ReadonlyMap<string, Overlay>
): SetupReport["promptShas"] {
  const dream = readDreamPrompts(repoRoot(), setup.dreamPrompt);
  return {
    chat: overlays.get(setup.prompt)?.promptSha ?? "unknown",
    dream:
      dream === null
        ? null
        : sha12(
            Object.keys(dream)
              .sort()
              .map((file) => `${file}\0${dream[file]}`)
              .join("\0")
          ),
  };
}

/**
 * The person pass runs once per Dream snapshot, and every setup that shares the
 * snapshot reports it. Its judge cost is split among them.
 */
function personShareOf(plan: RunPlan, setup: Setup): number {
  const key = dreamKeyId(setup);
  const group = plan.groups.find((candidate) => candidate.dreamKeyId === key);
  const count =
    group?.prompts.reduce((sum, prompt) => sum + prompt.setups.length, 0) ?? 1;
  return 1 / Math.max(1, count);
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

interface Planned {
  loaded: LoadedSweep;
  peopleById: Map<string, LoadedPerson>;
  plan: RunPlan;
  resolved: ResolvedTests;
  selected: LoadedPerson[];
  setups: Setup[];
}

/** Reads the sweep and the people, and works out what would run. */
async function planSweep(options: CliOptions): Promise<Planned> {
  const loaded = await loadSweep(options.sweep);
  const { sweep } = loaded;
  statusLine("Model lists replaced from the environment", loaded.overrides);

  const everyone = await loadAllPeople();
  const problems = dataProblems(everyone, EVAL_TODAY);
  if (problems.length > 0) {
    throw new Stop(`The eval data has problems:\n  ${problems.join("\n  ")}`);
  }
  // Openers and conversations marked alsoEmpty run on the empty journal, which
  // is new-user's Sage, so a sweep that sends them covers new-user when it
  // needs to. People the sweep excludes by tag (long-history is tagged long)
  // are left out, and so are their alsoEmpty items.
  const selected = selectPeople(everyone, sweep.tags, {
    conversations: sweep.tests.includes("conversations"),
    excludeTags: sweep.excludeTags,
    openers: sweep.tests.includes("openers"),
  });
  if (selected.length === 0) {
    throw new Stop(
      `No person matches the sweep's tags (${sweep.tags.join(", ")}).`,
      2
    );
  }
  const promptProblems = dreamPromptProblems(repoRoot(), sweep.dreamPrompts);
  if (promptProblems.length > 0) {
    throw new Stop(
      `The sweep's Dream prompts have problems:\n  ${promptProblems.join("\n  ")}`,
      2
    );
  }
  const resolved = resolveTests(sweep.tests, join(agentDir, "evals"));
  statusLine("Tests the runner does not start yet", resolved.deferred);
  statusLine("Eval files that do not exist yet", resolved.missing);
  const prefixCount = Object.values(resolved.prefixes).reduce(
    (sum, list) => sum + list.length,
    0
  );
  if (prefixCount === 0) {
    const message = `No eval files match the tests (${sweep.tests.join(", ")}).`;
    if (!options.dryRun) {
      throw new Stop(message, 2);
    }
    log(`${message} A real run would stop here.`);
  }
  const { setups } = loaded;
  const plan = buildPlan(setups, selected, sweep, {
    chat: needsChat(resolved.prefixes),
  });
  for (const line of describePlan(plan)) {
    log(line);
  }
  return {
    loaded,
    peopleById: new Map(selected.map((person) => [person.id, person])),
    plan,
    resolved,
    selected,
    setups,
  };
}

interface Roots {
  overlays: Map<string, Overlay>;
  targetRoot: string;
}

/**
 * Builds each Chat prompt overlay and the stub target, and checks each with
 * `eve info`. A sweep with no Chat has no overlays.
 */
async function prepareRoots(
  setups: readonly Setup[],
  chat: boolean
): Promise<Roots> {
  const overlays = new Map<string, Overlay>();
  const tools = liveToolNames(agentDir);
  for (const prompt of chat ? distinct(setups, "prompt") : []) {
    const overlay = buildOverlay(agentDir, prompt);
    // biome-ignore lint/performance/noAwaitInLoops: eve checks one root at a time.
    await verifyRoot(agentDir, overlay.root, tools);
    overlays.set(prompt, overlay);
    log(`Chat prompt ${prompt}: ${overlay.root} (sha ${overlay.promptSha})`);
  }
  const targetRoot = buildTargetRoot(agentDir);
  await verifyRoot(agentDir, targetRoot, null);
  log(`Grade target: ${targetRoot}`);
  return { overlays, targetRoot };
}

interface Cleanup {
  eveStub: EveServer | null;
  pull: PullServer | null;
}

export interface OllamaCheck {
  bin: string;
  check: ModelCheck;
  digests: DigestLookup;
}

/** Starts the pull server and reads what Ollama has: capabilities and digests. */
async function inspectModels(
  cleanup: Cleanup,
  setups: readonly Setup[],
  dryRun: boolean,
  chat: boolean
): Promise<OllamaCheck> {
  const bin = await fetchPinnedOllama(root);
  cleanup.pull = await startPullServer({ bin, host: OLLAMA_HOST });
  const roles = modelRoles(setups, chat);
  const check = await checkModels(OLLAMA_HOST, roles);
  statusLine("Not pulled yet", check.missing);
  statusLine("Cannot think (think-on setups are skipped)", check.cannotThink);
  if (check.problems.length > 0) {
    const message = `Model problems:\n  ${check.problems.join("\n  ")}`;
    if (!dryRun) {
      throw new Stop(message);
    }
    console.error(message);
  }
  return {
    bin,
    check,
    digests: await snapshotDigests(modelsOf(setups, chat), OLLAMA_HOST),
  };
}

async function dreamMissesFor(
  plan: RunPlan,
  people: ReadonlyMap<string, LoadedPerson>,
  digests: DigestLookup
): Promise<Set<string>> {
  const misses = new Set<string>();
  for (const group of plan.groups) {
    for (const planned of plan.people) {
      const person = people.get(planned.id);
      if (person === undefined || !needsDream(person)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each key is a few small file reads.
      const key = await dreamKeyFor(
        {
          dreamPrompt: group.dreamPrompt,
          embedModel: group.embedModel,
          memory: group.memory,
          person,
          summaryModel: group.summaryModel,
        },
        digests
      );
      const cached =
        evalCacheEnabled() &&
        cachedDreamEntry(key.key, evalCacheDir()) !== null;
      if (!cached) {
        misses.add(dreamMissKey(group.dreamKeyId, person.id));
      }
    }
  }
  return misses;
}

/** Prints the hours and dollars the sweep should take. */
async function printEstimate(
  planned: Planned,
  plan: RunPlan,
  digests: DigestLookup,
  runDir: string
): Promise<Estimate> {
  const { sweep } = planned.loaded;
  const book = await loadPriceBook(
    [
      { fallback: DEFAULT_PRICE, id: sweep.judge.model },
      { fallback: DEFAULT_SIMULATED_USER_PRICE, id: sweep.simulatedUser.model },
    ],
    priceCacheFile(runDir)
  );
  const estimate = estimateRun({
    dreamMisses: await dreamMissesFor(plan, planned.peopleById, digests),
    history: loadTimingHistory(join(agentDir, "evals", "reports")),
    judgeCheck: await judgeCheckSize(),
    plan,
    prices: {
      judge: book.prices[sweep.judge.model] ?? DEFAULT_PRICE,
      simulatedUser:
        book.prices[sweep.simulatedUser.model] ?? DEFAULT_SIMULATED_USER_PRICE,
    },
    sweep,
  });
  for (const line of formatEstimate(estimate, {
    capUsd: sweep.spendingCapUsd,
    defaultedPrices: book.defaulted,
  })) {
    log(line);
  }
  return estimate;
}

/** The judge and the simulated user are cloud models, and need a key. */
function credentialProblems(model: string): string[] {
  if (Object.keys(gatewayCredentials()).length > 0) {
    return [];
  }
  return [
    `No AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set, so the judge (${model}) cannot run. Put one in agent/.env.local.`,
  ];
}

async function confirmRun(options: CliOptions): Promise<void> {
  if (options.yes) {
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Stop(
      "Not a terminal, so there is nobody to ask. Pass --yes to run.",
      2
    );
  }
  if (!(await ask("Continue? [y/N] "))) {
    throw new Stop("Stopped before anything ran.", 0);
  }
}

export interface PullDeps {
  host: string;
  pull: (bin: string, host: string, model: string) => Promise<void>;
}

export interface PulledModels {
  /** Chat models that cannot think, including the ones just pulled. */
  cannotThink: Set<string>;
  /** Digests read after the pulls, so a model pulled just now has one. */
  digests: DigestLookup;
}

/**
 * Pulls what is missing, then checks again and reads the digests. The digests
 * of the models that were already there were read earlier, but a model pulled
 * now has none yet, and the Dream cache key needs it. Ollama is still up here:
 * the pull server stops after this.
 */
export async function pullMissing(
  inspected: OllamaCheck,
  setups: readonly Setup[],
  deps: PullDeps = { host: OLLAMA_HOST, pull: pullModel },
  chat = true
): Promise<PulledModels> {
  for (const model of inspected.check.missing) {
    // biome-ignore lint/performance/noAwaitInLoops: pulls run one at a time so the progress is readable.
    await deps.pull(inspected.bin, deps.host, model);
  }
  const cannotThink = new Set(inspected.check.cannotThink);
  if (inspected.check.missing.length === 0) {
    return { cannotThink, digests: inspected.digests };
  }
  const again = await checkModels(deps.host, modelRoles(setups, chat));
  const problems = [
    ...again.problems,
    ...again.missing.map((model) => `${model} is still not in Ollama.`),
  ];
  if (problems.length > 0) {
    throw new Stop(`Model problems:\n  ${problems.join("\n  ")}`);
  }
  for (const model of again.cannotThink) {
    cannotThink.add(model);
  }
  return {
    cannotThink,
    digests: await snapshotDigests(modelsOf(setups, chat), deps.host),
  };
}

async function buildAll(
  plan: RunPlan,
  runDir: string
): Promise<Map<Memory, string>> {
  const builds = new Map<Memory, string>();
  for (const memory of plan.memoryValues) {
    // biome-ignore lint/performance/noAwaitInLoops: Zig builds are heavy; one at a time.
    const binary = await buildSage({
      logFile: join(runDir, "logs", `build-mem-${memory}.log`),
      memory,
      root,
    });
    builds.set(memory, binary);
  }
  return builds;
}

async function runLoop(ctx: RunContext, plan: RunPlan): Promise<void> {
  for (const memory of plan.memoryValues) {
    for (const group of plan.groups.filter((g) => g.memory === memory)) {
      for (const person of plan.people) {
        if (ctx.abort.aborted) {
          return;
        }
        // biome-ignore lint/performance/noAwaitInLoops: one Sage at a time; local generation never overlaps.
        await runPersonUnit(ctx, group, person.id);
      }
    }
  }
}

interface RunFacts {
  estimate: { costUsd: number; hours: number };
  judgeCheck: SweepSummary["judgeCheck"];
  started: number;
}

/** Assembles and writes the setup reports and the sweep summary. Returns how many setups reported. */
async function writeAllReports(
  ctx: RunContext,
  plan: RunPlan,
  loaded: LoadedSweep,
  run: RunFacts
): Promise<number> {
  const commit = await gitCommit();
  const peopleIds = plan.people.map((person) => person.id);
  const reports: SetupReport[] = [];
  for (const setup of plan.setups) {
    const data = collectSetupData(
      ctx.runDir,
      { dreamKeyId: dreamKeyId(setup), setupId: setupIdOf(setup) },
      peopleIds
    );
    if (data.rows.length === 0 && data.transcripts.length === 0) {
      continue;
    }
    reports.push(
      assembleSetupReport({
        gitCommit: commit,
        people: peopleIds,
        personShare: personShareOf(plan, setup),
        promptShas: promptShasFor(setup, ctx.overlays),
        rows: data.rows,
        setup,
        swap: readSwapReading(ctx.runDir, setupIdOf(setup)),
        sweep: ctx.sweep,
        sweepId: ctx.sweepId,
        transcripts: data.transcripts,
      })
    );
  }
  const spent = spentUsd(ctx.runDir);
  const hours = (Date.now() - run.started) / 3_600_000;
  const summary = assembleSweepSummary({
    actual: { costUsd: spent, hours },
    estimate: run.estimate,
    judgeCheck: run.judgeCheck,
    reports,
    sweep: ctx.sweep,
    sweepFile: `${loaded.name}.yaml`,
    sweepId: ctx.sweepId,
  });
  const written = writeReports(ctx.reportsDir, reports, summary);
  log(
    `Wrote ${written.length} file${written.length === 1 ? "" : "s"} to ${ctx.reportsDir}`
  );
  for (const line of describeRanking(summary, reports)) {
    log(line);
  }
  log(
    `Took ${hours.toFixed(1)} hours (estimated ${run.estimate.hours.toFixed(1)}). Cloud spending $${spent.toFixed(2)} (estimated $${run.estimate.costUsd.toFixed(2)}).`
  );
  return reports.length;
}

/** The old runner ended by asking about an upload. The script still does the asking. */
function offerUpload(): void {
  spawnSync("sh", [join(root, "scripts", "eval-upload.sh")], {
    cwd: root,
    // The upload needs the Blob variables. It does not need a gateway key.
    env: uploadEnv(),
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function sweepBody(
  options: CliOptions,
  cleanup: Cleanup,
  abort: { aborted: boolean },
  started: number
): Promise<number> {
  heading(`Sweep ${options.sweep}${options.dryRun ? " (dry run)" : ""}`);
  const planned = await planSweep(options);
  const { loaded, peopleById, resolved } = planned;
  const { sweep } = loaded;

  const sweepId = makeSweepId(options.sweep);
  const runDir = join(agentDir, "evals", ".runs", sweepId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const sweepFile = join(runDir, "sweep.json");
  writeFileSync(sweepFile, resolvedSweepJson(sweep));

  // The simulated user goes first, before any local work. A sweep with
  // conversations cannot hold one without it, and a night of generation should
  // not be spent finding that out at the first conversation.
  if (runsConversations(planned.resolved.prefixes)) {
    const problem = await simulatedUserProblem(sweep.simulatedUser, runDir);
    if (problem !== undefined) {
      console.error(problem);
      if (!options.dryRun) {
        throw new Stop("", 2);
      }
      log("A real run would stop here.");
    }
  }

  const { chat } = planned.plan;
  heading(chat ? "Chat prompts and grade target" : "Grade target");
  const { overlays, targetRoot } = await prepareRoots(planned.setups, chat);
  const eveStub = await startEveServer({
    agentDir,
    logFile: join(runDir, "logs", "grade-target.log"),
    ollamaBaseUrl: ollamaApiBase(OLLAMA_HOST),
    root: targetRoot,
    withWorkflowGuard: false,
  });
  cleanup.eveStub = eveStub;
  log(`Grade target is up at ${eveStub.url}`);

  heading("Models and estimate");
  const inspected = await inspectModels(
    cleanup,
    planned.setups,
    options.dryRun,
    chat
  );
  const cannotThink = new Set(inspected.check.cannotThink);
  let setups = withoutImpossibleThinking(planned.setups, cannotThink);
  let plan = buildPlan(setups, planned.selected, sweep, { chat });
  const estimate = await printEstimate(
    planned,
    plan,
    inspected.digests,
    runDir
  );
  const missingKeys = credentialProblems(sweep.judge.model);
  for (const note of missingKeys) {
    console.error(note);
  }
  if (options.dryRun) {
    log(
      "\nDry run: no models ran, and nothing was built or pulled. A real run starts with the judge check."
    );
    return 0;
  }
  if (missingKeys.length > 0) {
    throw new Stop("", 2);
  }
  await confirmRun(options);

  // The check goes before any local work, so a judge that misses a planted
  // failure costs a few cents and not a night.
  heading("Judge check");
  const judgeCheck = await runJudgeCheck({
    agentDir,
    credentials: credentialsFrom(),
    runDir,
    stubUrl: eveStub.url,
    sweepFile,
    sweepId,
  });
  if (!judgeCheck.ok) {
    throw new Stop(judgeCheck.lines.join("\n"));
  }
  for (const line of judgeCheck.lines) {
    log(line);
  }

  heading("Pulling models");
  const pulled = await pullMissing(inspected, planned.setups, undefined, chat);
  const thinkers = pulled.cannotThink;
  setups = withoutImpossibleThinking(planned.setups, thinkers);
  plan = buildPlan(setups, planned.selected, sweep, { chat });
  // Sage binds the port itself, so the pull server goes first.
  await cleanup.pull?.stop();
  cleanup.pull = null;

  heading("Building Sage");
  const builds = await buildAll(plan, runDir);

  const ctx: RunContext = {
    abort,
    agentDir,
    builds,
    cannotThink: thinkers,
    credentials: credentialsFrom(),
    digests: pulled.digests,
    failures: [],
    filters: options.eveFilters,
    listCache: new Map(),
    ollama: { bin: inspected.bin, host: OLLAMA_HOST },
    overlays,
    passesWithFailures: 0,
    people: peopleById,
    pool: new JobPool(MAX_GRADE_PROCESSES),
    prefixes: resolved.prefixes,
    reportsDir: join(agentDir, "evals", "reports"),
    root,
    runDir,
    stubUrl: eveStub.url,
    sweep,
    sweepFile,
    sweepId,
  };
  mkdirSync(ctx.reportsDir, { recursive: true });

  heading("Running");
  await runLoop(ctx, plan);
  await ctx.pool.drain();

  heading("Reports");
  const reported = await writeAllReports(ctx, plan, loaded, {
    estimate,
    judgeCheck: judgeCheck.summary,
    started,
  });
  if (ctx.failures.length > 0) {
    console.error(`\n${ctx.failures.length} problem(s):`);
    for (const failure of ctx.failures) {
      console.error(`  ${failure}`);
    }
  }
  if (reported > 0) {
    offerUpload();
  }
  return ctx.failures.length > 0 || ctx.passesWithFailures > 0 ? 1 : 0;
}

async function runSweep(options: CliOptions): Promise<number> {
  const started = Date.now();
  const cleanup: Cleanup = { eveStub: null, pull: null };
  const abort: { aborted: boolean } = { aborted: false };
  const onSignal = (signal: string): void => {
    if (abort.aborted) {
      killAllTracked();
      removeBuilds(root);
      process.exit(130);
    }
    abort.aborted = true;
    console.error(`\n${signal}: stopping. Press Ctrl-C again to quit at once.`);
    // Sage gets SIGTERM first, so it can stop its own Ollama. Anything still
    // running after the grace period is ended, and so is a leftover Ollama.
    terminateAllTracked(SIGNAL_GRACE_MS).catch(() => {
      killAllTracked();
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("exit", () => {
    killAllTracked();
    removeBuilds(root);
  });

  try {
    return await sweepBody(options, cleanup, abort, started);
  } catch (error) {
    if (error instanceof Stop) {
      if (error.message.length > 0) {
        console.error(error.message);
      }
      return error.exitCode;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await cleanup.eveStub?.stop();
    await cleanup.pull?.stop();
    killAllTracked();
    removeBuilds(root);
  }
}

export async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  loadEvalEnv(agentDir);
  return await runSweep(options);
}
