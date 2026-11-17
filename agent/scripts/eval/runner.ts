// `make eval`: runs a sweep file.
//
//   node --experimental-strip-types agent/scripts/eval/run.ts [--sweep <name>] [--dry-run] [--yes] [eve filters]
//
// Replaces scripts/eval-run.sh. The run goes in stages: plan, check the
// simulated user (when the sweep runs conversations), check the Chat prompts
// and the grade target, check the models and print the estimate, ask, pull,
// build, run, and write the reports. `--dry-run` stops after the estimate.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
import { describeCalibration } from "../../evals/lib/calibration.ts";
import {
  describeHeadToHead,
  type HeadToHeadPlan,
} from "../../evals/lib/head-to-head.ts";
import { priceCacheFile } from "../../evals/lib/prices.ts";
import {
  dreamKeyId,
  type Memory,
  type Setup,
  type SetupReport,
  type SweepSummary,
  setupId as setupIdOf,
  sweepSummarySchema,
} from "../../evals/lib/schema.ts";
import {
  calibrationInputs,
  calibrationReportOf,
  readCalibration,
  writeCalibrationReport,
} from "./calibration-run.ts";
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
import {
  describePlan as describeHeadToHeadPlan,
  headToHeadPreflight,
  headToHeadSummaryOf,
  mergeHeadToHead,
  readHeadToHead,
} from "./head-to-head-run.ts";
import {
  type JudgeCheckDeps,
  type JudgeCheckResult,
  type JudgeCheckRun,
  judgeCheckSize,
  runJudgeCheck,
} from "./judge-check.ts";
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
  standaloneTest,
} from "./plan.ts";
import { captureCommand, killAllTracked, terminateAllTracked } from "./proc.ts";
import {
  assembleSetupReport,
  assembleSweepSummary,
  describeRanking,
  writeReports,
} from "./report.ts";
import {
  createProgress,
  describeResume,
  doneCounts,
  PLAN_FILE,
  type PlanFile,
  type Progress,
  planFileFor,
  ResumeError,
  readPlanFile,
  type Step,
  sweepHash,
  writePlanFile,
} from "./resume.ts";
import { buildSage, removeBuilds } from "./sage.ts";
import {
  estimateCalibration,
  estimateHeadToHead,
  estimateJudgeCheck,
  runStandalone,
  type StandaloneEstimate,
  unwrittenReason,
} from "./standalone.ts";
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
const runsDir = join(agentDir, "evals", ".runs");
const reportsRoot = join(agentDir, "evals", "reports");

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

/**
 * What to throw for an error caught around a step that has known, readable
 * problems. A `Stop` and a `ResumeError` end the run with their message. Any
 * other error is a readable problem only when the step says so (`anyError`),
 * as the reading of a sample or a finished sweep does. Otherwise it is a bug
 * and goes on unchanged.
 */
function stopFrom(error: unknown, anyError: boolean): unknown {
  if (error instanceof Stop) {
    return error;
  }
  if (error instanceof ResumeError || (anyError && error instanceof Error)) {
    return new Stop(error.message, 2, { cause: error });
  }
  return error;
}

/** Ends the run with a message and an exit code. Thrown from any stage. */
class Stop extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1, options?: { cause?: unknown }) {
    super(message, options);
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

/** Reads the people and works out what would run. */
async function planSweep(
  options: CliOptions,
  loaded: LoadedSweep
): Promise<Planned> {
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
  /** Saves how long the run has taken, for a later `--resume`. Set once the run folder exists. */
  elapsed: (() => void) | null;
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
// Resuming
// ---------------------------------------------------------------------------

/** The run folders that have a plan file, newest last. For the message when `--resume` names none. */
function knownRuns(): string[] {
  try {
    return readdirSync(runsDir)
      .filter((name) => readPlanFile(join(runsDir, name)) !== null)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The sweep file a run uses. A new run takes `--sweep`. A resumed run takes the
 * name its plan file recorded, because `make eval` always passes `--sweep`, and
 * its default is `default`. Naming another sweep for a resume is a mistake.
 */
export function sweepNameOf(
  options: CliOptions,
  recorded: PlanFile | null
): string {
  if (recorded === null) {
    return options.sweep;
  }
  if (options.sweep !== "default" && options.sweep !== recorded.sweepFile) {
    throw new Stop(
      `${recorded.sweepId} is a ${recorded.sweepFile} sweep, and --sweep says ${options.sweep}. Leave --sweep out to resume it.`,
      2
    );
  }
  return recorded.sweepFile;
}

/**
 * The judge check, unless an earlier run of this sweep passed it. It writes
 * its rows into the run folder and appends to them, so a check that was
 * stopped halfway starts from scratch.
 */
export async function judgeCheckOnce(
  progress: Progress,
  run: JudgeCheckRun,
  deps?: JudgeCheckDeps
): Promise<JudgeCheckResult> {
  const step: Step = { kind: "judge-check" };
  const earlier = sweepSummarySchema.shape.judgeCheck.safeParse(
    progress.readMarker(step)?.data
  );
  if (progress.isDone(step) && earlier.success && earlier.data.passed) {
    return {
      checked: 0,
      lines: ["Judge check: passed in an earlier run, so it is not run again."],
      ok: true,
      summary: earlier.data,
    };
  }
  progress.reset(step);
  const result = await runJudgeCheck(run, deps);
  if (!result.ok) {
    throw new Stop(result.lines.join("\n"));
  }
  progress.markDone(step, result.summary);
  return result;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Reads the plan file of the run to resume, if there is one, and loads the
 * sweep the run uses. `--compare` is applied to the sweep file.
 */
async function loadRun(
  options: CliOptions
): Promise<{ loaded: LoadedSweep; recorded: PlanFile | null }> {
  const recorded =
    options.resume === undefined
      ? null
      : readPlanFile(join(runsDir, options.resume));
  if (options.resume !== undefined && recorded === null) {
    throw new Stop(
      `Nothing to resume: ${join(runsDir, options.resume, PLAN_FILE)} does not exist. A run writes it when it starts, so the id is wrong or the run never began. The runs here: ${knownRuns().join(", ") || "none"}.`,
      2
    );
  }
  const sweepName = sweepNameOf(options, recorded);
  heading(
    `${options.resume === undefined ? "Sweep" : "Resuming"} ${sweepName}${options.dryRun ? " (dry run)" : ""}`
  );
  const loaded = await loadSweep(sweepName, process.env, undefined, {
    compare: options.compare,
  });
  return { loaded, recorded };
}

interface OpenedRun {
  planFile: PlanFile;
  progress: Progress;
  runDir: string;
  sweepFile: string;
  sweepId: string;
}

/**
 * The run folder, the plan file, and the done markers. A new run gets an id
 * and a plan. A resumed run keeps its id, and the plan it recorded must match
 * what is about to run: the hash of the resolved sweep, the setups, and the
 * people. The resolved sweep is written again, as it was the first time.
 */
function openRun(
  options: CliOptions,
  planned: Planned,
  recorded: PlanFile | null
): OpenedRun {
  const { loaded } = planned;
  const sweepId = options.resume ?? makeSweepId(loaded.name);
  const runDir = join(runsDir, sweepId);
  let planFile: PlanFile;
  try {
    planFile = planFileFor(
      sweepId,
      recorded,
      {
        people: planned.selected.map((person) => person.id),
        setupIds: planned.setups.map(setupIdOf),
        sweepFile: loaded.name,
        sweepHash: sweepHash(loaded.sweep),
      },
      options.resume !== undefined
    );
  } catch (error) {
    throw stopFrom(error, false);
  }
  if (options.resume !== undefined) {
    for (const line of describeResume(planFile, doneCounts(runDir))) {
      log(line);
    }
  }
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const sweepFile = join(runDir, "sweep.json");
  writeFileSync(sweepFile, resolvedSweepJson(loaded.sweep));
  return {
    planFile,
    progress: createProgress(runDir),
    runDir,
    sweepFile,
    sweepId,
  };
}

/**
 * Writes the plan file for this session, and arranges for the time taken to be
 * saved when the run ends, however it ends. Time counts across sessions, so the
 * report says how long the whole sweep took. Returns the moment the sweep
 * started, as if it had never stopped. A dry run writes no plan file, so there
 * is nothing to resume.
 */
function trackElapsed(
  options: CliOptions,
  cleanup: Cleanup,
  runDir: string,
  planFile: PlanFile
): number {
  const sweepStarted = Date.now() - planFile.priorMs;
  if (!options.dryRun) {
    const sessions = planFile.sessions + 1;
    writePlanFile(runDir, { ...planFile, sessions });
    cleanup.elapsed = () =>
      writePlanFile(runDir, {
        ...planFile,
        priorMs: Date.now() - sweepStarted,
        sessions,
      });
  }
  return sweepStarted;
}

async function sweepBody(
  options: CliOptions,
  cleanup: Cleanup,
  abort: { aborted: boolean }
): Promise<number> {
  const { loaded, recorded } = await loadRun(options);
  const standalone = standaloneTest(loaded.sweep.tests);
  if (standalone !== null) {
    if (options.resume !== undefined) {
      throw new Stop(
        `${options.resume} is a ${standalone} sweep, which has no steps to skip. It runs in minutes, so run it again instead of resuming it.`,
        2
      );
    }
    return await runStandaloneSweep(
      standalone,
      options,
      loaded,
      cleanup,
      abort
    );
  }
  const planned = await planSweep(options, loaded);
  const { peopleById, resolved } = planned;
  const { sweep } = loaded;
  const { planFile, progress, runDir, sweepFile, sweepId } = openRun(
    options,
    planned,
    recorded
  );
  const sweepStarted = trackElapsed(options, cleanup, runDir, planFile);

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
  const judgeCheck = await judgeCheckOnce(progress, {
    agentDir,
    credentials: credentialsFrom(),
    runDir,
    stubUrl: eveStub.url,
    sweepFile,
    sweepId,
  });
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
    progress,
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
    started: sweepStarted,
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

// ---------------------------------------------------------------------------
// Sweeps with no Sage: calibration and head-to-head
// ---------------------------------------------------------------------------

interface StandaloneRoots {
  runDir: string;
  stubUrl: string;
  sweepFile: string;
  sweepId: string;
}

/** Makes the run folder, writes the resolved sweep, and starts the stub grade target. */
async function startStandalone(
  loaded: LoadedSweep,
  cleanup: Cleanup
): Promise<StandaloneRoots> {
  const sweepId = makeSweepId(loaded.name);
  const runDir = join(runsDir, sweepId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const sweepFile = join(runDir, "sweep.json");
  writeFileSync(sweepFile, resolvedSweepJson(loaded.sweep));
  heading("Grade target");
  const { targetRoot } = await prepareRoots([], false);
  const eveStub = await startEveServer({
    agentDir,
    logFile: join(runDir, "logs", "grade-target.log"),
    ollamaBaseUrl: ollamaApiBase(OLLAMA_HOST),
    root: targetRoot,
    withWorkflowGuard: false,
  });
  cleanup.eveStub = eveStub;
  log(`Grade target is up at ${eveStub.url}`);
  return { runDir, stubUrl: eveStub.url, sweepFile, sweepId };
}

/** Prints an estimate, and the cap warning when it passes the sweep's cap. */
function printStandaloneEstimate(
  estimate: StandaloneEstimate,
  extras: { capUsd: number; defaulted: readonly string[]; lines?: string[] }
): void {
  for (const line of estimate.lines) {
    log(line);
  }
  for (const line of extras.lines ?? []) {
    log(`  ${line}`);
  }
  if (extras.defaulted.length > 0) {
    log(
      `  No gateway price for ${extras.defaulted.join(", ")}; the estimate uses default prices.`
    );
  }
  if (estimate.costUsd > extras.capUsd) {
    log(
      `  The estimate is over the $${extras.capUsd} spending cap. Past the cap, the rest is marked "not graded".`
    );
  }
}

interface StandaloneInputs {
  /** Judge calls the pass will make. */
  calls: number;
  /** The sweep a head-to-head compares. */
  compare?: string;
  /** What a head-to-head will compare. An item the pass records no row for counts as not graded. */
  plan?: HeadToHeadPlan;
  /** The calibration samples in use. */
  samples: string[];
  /** The setups a head-to-head compares, best first. */
  setups: string[];
}

/**
 * What the pass will work on, read before anything is built or started, so a
 * missing sample, an ungraded sample, or a sweep that is not finished stops
 * the run here.
 */
function standaloneInputs(
  kind: "calibration" | "head-to-head",
  sweep: LoadedSweep["sweep"]
): StandaloneInputs {
  try {
    if (kind === "calibration") {
      const inputs = calibrationInputs(sweep.compare);
      log(
        `${inputs.graded} of ${inputs.sampled} sampled replies are graded (${inputs.samples.join(", ")}).`
      );
      return { calls: inputs.graded, samples: inputs.samples, setups: [] };
    }
    const { compare } = sweep;
    if (compare === undefined) {
      throw new Stop(
        "head-to-head needs a finished sweep to compare. Pass --compare <sweep id> (the id is a file name in agent/evals/reports/, before .sweep.json), or set compare in the sweep file.",
        2
      );
    }
    const preflight = headToHeadPreflight(compare, sweep.compareTop, {
      reportsDir: reportsRoot,
      runsDir,
    });
    for (const line of describeHeadToHeadPlan(preflight.plan)) {
      log(line);
    }
    return {
      calls: preflight.calls,
      compare,
      plan: preflight.plan,
      samples: [],
      setups: preflight.plan.setups,
    };
  } catch (error) {
    throw stopFrom(error, true);
  }
}

/** Prints the estimate for a standalone sweep, and returns its dollars. */
async function standaloneEstimate(
  kind: "calibration" | "head-to-head",
  loaded: LoadedSweep,
  roots: StandaloneRoots,
  calls: number
): Promise<number> {
  const { sweep } = loaded;
  const book = await loadPriceBook(
    [{ fallback: DEFAULT_PRICE, id: sweep.judge.model }],
    priceCacheFile(roots.runDir)
  );
  const price = book.prices[sweep.judge.model] ?? DEFAULT_PRICE;
  const estimate =
    kind === "calibration"
      ? estimateCalibration(calls, price)
      : estimateHeadToHead(calls, price);
  // Head-to-head runs the judge check first, as every sweep that uses the judge does.
  const checkUsd =
    kind === "head-to-head"
      ? estimateJudgeCheck(await judgeCheckSize(), price)
      : 0;
  const note =
    kind === "calibration"
      ? "There is no judge check, because this sweep measures the judge."
      : `The judge check that starts the sweep adds about $${checkUsd.toFixed(2)}.`;
  const total = estimate.costUsd + checkUsd;
  printStandaloneEstimate(
    { ...estimate, costUsd: total },
    { capUsd: sweep.spendingCapUsd, defaulted: book.defaulted, lines: [note] }
  );
  return total;
}

/**
 * `tests: [calibration]` and `tests: [head-to-head]`. Each is one grade pass
 * against the stub target. They start no Sage and no Ollama, build nothing,
 * and pull nothing. Head-to-head runs the judge check first, like any sweep
 * that uses the judge. Calibration does not: it measures the judge against
 * your grades, and a judge that fails the check should still show its numbers.
 */
async function runStandaloneSweep(
  kind: "calibration" | "head-to-head",
  options: CliOptions,
  loaded: LoadedSweep,
  cleanup: Cleanup,
  abort: { aborted: boolean }
): Promise<number> {
  const { sweep } = loaded;
  heading(kind === "calibration" ? "Calibration" : "Head to head");
  const resolved = resolveTests(sweep.tests, join(agentDir, "evals"));
  if (resolved.missing.length > 0) {
    throw new Stop(
      `Eval files that do not exist: ${resolved.missing.join(", ")}.`,
      2
    );
  }
  const inputs = standaloneInputs(kind, sweep);
  const roots = await startStandalone(loaded, cleanup);
  heading("Estimate");
  const estimatedUsd = await standaloneEstimate(
    kind,
    loaded,
    roots,
    inputs.calls
  );
  const missingKeys = credentialProblems(sweep.judge.model);
  for (const note of missingKeys) {
    console.error(note);
  }
  if (options.dryRun) {
    log("\nDry run: no judge call was made.");
    return 0;
  }
  if (missingKeys.length > 0) {
    throw new Stop("", 2);
  }
  await confirmRun(options);

  const credentials = credentialsFrom();
  if (kind === "head-to-head") {
    heading("Judge check");
    const check = await runJudgeCheck({
      agentDir,
      credentials,
      runDir: roots.runDir,
      stubUrl: roots.stubUrl,
      sweepFile: roots.sweepFile,
      sweepId: roots.sweepId,
    });
    if (!check.ok) {
      throw new Stop(check.lines.join("\n"));
    }
    for (const line of check.lines) {
      log(line);
    }
  }

  heading(kind === "calibration" ? "Comparing with your grades" : "Comparing");
  const result = await runStandalone({
    agentDir,
    credentials,
    filters: options.eveFilters,
    name: kind,
    prefixes: resolved.prefixes.grade,
    runDir: roots.runDir,
    stubUrl: roots.stubUrl,
    sweepFile: roots.sweepFile,
    sweepId: roots.sweepId,
  });
  heading("Result");
  const spent = spentUsd(roots.runDir);
  const unwritten = unwrittenReason(kind, result, abort.aborted);
  if (unwritten !== null) {
    log(unwritten);
  } else if (kind === "calibration") {
    reportCalibration(sweep.judge.model, inputs, result.rows, roots, spent);
  } else {
    reportHeadToHead(sweep.judge.model, inputs, result.rows, roots, spent);
  }
  log(
    `Cloud spending $${spent.toFixed(2)} (estimated $${estimatedUsd.toFixed(2)}).`
  );
  for (const problem of result.problems) {
    console.error(problem);
  }
  return unwritten === null ? 0 : 1;
}

function reportCalibration(
  judgeModel: string,
  inputs: StandaloneInputs,
  rows: Parameters<typeof readCalibration>[0],
  roots: StandaloneRoots,
  costUsd: number
): void {
  const report = calibrationReportOf({
    costUsd,
    humanGraded: inputs.calls,
    judgeModel,
    reading: readCalibration(rows),
    samples: inputs.samples,
    sweepId: roots.sweepId,
  });
  for (const line of describeCalibration(report)) {
    log(line);
  }
  log(`Wrote ${writeCalibrationReport(reportsRoot, report)}`);
}

function reportHeadToHead(
  judgeModel: string,
  inputs: StandaloneInputs,
  rows: Parameters<typeof readHeadToHead>[0],
  roots: StandaloneRoots,
  costUsd: number
): void {
  if (inputs.compare === undefined) {
    return;
  }
  const summary = headToHeadSummaryOf({
    costUsd,
    judgeModel,
    reading: readHeadToHead(rows, inputs.plan),
    setups: inputs.setups,
    sweepId: roots.sweepId,
  });
  for (const line of describeHeadToHead(summary)) {
    log(line);
  }
  log(`Added to ${mergeHeadToHead(reportsRoot, inputs.compare, summary).path}`);
}

async function runSweep(options: CliOptions): Promise<number> {
  const cleanup: Cleanup = { elapsed: null, eveStub: null, pull: null };
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
    return await sweepBody(options, cleanup, abort);
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
    cleanup.elapsed?.();
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
