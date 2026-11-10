// `make eval`: runs a sweep file.
//
//   node --experimental-strip-types agent/scripts/eval/run.ts [--sweep <name>] [--dry-run] [--yes] [eve filters]
//
// Replaces scripts/eval-run.sh. See docs/agent/evals.md and
// agent/evals/README.md for the loop this file drives.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cachedDreamEntry,
  evalCacheDir,
  evalCacheEnabled,
  readDreamPrompts,
  repoRoot,
} from "../../evals/lib/cache.ts";
import {
  dreamKeyId,
  type Memory,
  type Setup,
  setupId as setupIdOf,
  type SetupReport,
  type SweepSummary,
} from "../../evals/lib/schema.ts";
import { CliError, type CliOptions, parseCli, USAGE } from "./cli.ts";
import { collectSetupData } from "./collect.ts";
import {
  DEFAULT_PRICE,
  DEFAULT_SIMULATED_USER_PRICE,
  ledgerReader,
  loadPriceBook,
} from "./cloud.ts";
import { CostMeter } from "./cost.ts";
import { dreamKeyFor, needsDream } from "./dream.ts";
import { captureCommand, killAllTracked } from "./proc.ts";
import { gatewayCredentials, loadEvalEnv, withoutSecrets } from "./env.ts";
import {
  dreamMissKey,
  estimateRun,
  formatEstimate,
  loadTimingHistory,
} from "./estimate.ts";
import { EVAL_TODAY, type EveServer, startEveServer } from "./eve.ts";
import {
  checkModels,
  fetchPinnedOllama,
  OLLAMA_HOST,
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
import { JobPool, MAX_GRADE_PROCESSES, credentialsFrom } from "./passes.ts";
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
  type PassPrefixes,
  type RunPlan,
  resolveTests,
} from "./plan.ts";
import {
  assembleSetupReport,
  assembleSweepSummary,
  describeRanking,
  writeReports,
} from "./report.ts";
import { buildSage, removeBuilds } from "./sage.ts";
import {
  defaultSweepsDir,
  type LoadedSweep,
  loadSweep,
  makeSweepId,
  resolvedSweepJson,
} from "./sweep.ts";
import { type RunContext, runPersonUnit } from "./unit.ts";

const agentDir = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/u,
  ""
);
const root = dirname(agentDir);

function log(message: string): void {
  console.log(message);
}

function heading(message: string): void {
  console.log(`\n== ${message}`);
}

// ---------------------------------------------------------------------------
// Pieces of the run
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

interface Overlays {
  overlays: Map<string, Overlay>;
  targetRoot: string;
}

/** Builds each Chat prompt overlay and the stub target, and checks each with `eve info`. */
async function prepareRoots(setups: readonly Setup[]): Promise<Overlays> {
  const overlays = new Map<string, Overlay>();
  const tools = liveToolNames(agentDir);
  for (const prompt of distinct(setups, "prompt")) {
    const overlay = buildOverlay(agentDir, prompt);
    // biome-ignore lint/performance/noAwaitInLoops: eve builds one root at a time.
    await verifyRoot(agentDir, overlay.root, tools);
    overlays.set(prompt, overlay);
    log(`Chat prompt ${prompt}: ${overlay.root} (sha ${overlay.promptSha})`);
  }
  const targetRoot = buildTargetRoot(agentDir);
  await verifyRoot(agentDir, targetRoot, null);
  log(`Grade target: ${targetRoot}`);
  return { overlays, targetRoot };
}

function statusLine(label: string, items: readonly string[]): void {
  if (items.length > 0) {
    log(`${label}: ${items.join(", ")}`);
  }
}

interface Preflight {
  cannotThink: Set<string>;
  ollamaBin: string;
  pull: PullServer;
}

async function startOllama(): Promise<{ bin: string; pull: PullServer }> {
  const bin = await fetchPinnedOllama(root);
  const pull = await startPullServer({ bin, host: OLLAMA_HOST });
  return { bin, pull };
}

function modelRoles(setups: readonly Setup[]) {
  return {
    chat: distinct(setups, "chatModel"),
    embed: distinct(setups, "embedModel"),
    summary: distinct(setups, "summaryModel"),
  };
}

async function dreamMissesFor(
  plan: RunPlan,
  people: ReadonlyMap<string, LoadedPerson>
): Promise<Set<string>> {
  const misses = new Set<string>();
  if (!evalCacheEnabled()) {
    for (const group of plan.groups) {
      for (const person of plan.people) {
        misses.add(dreamMissKey(group.dreamKeyId, person.id));
      }
    }
    return misses;
  }
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
        OLLAMA_HOST
      );
      if (cachedDreamEntry(key.key, evalCacheDir()) === null) {
        misses.add(dreamMissKey(group.dreamKeyId, person.id));
      }
    }
  }
  return misses;
}

function spendingNotes(sweep: LoadedSweep["sweep"]): string[] {
  const credentials = Object.keys(gatewayCredentials());
  if (credentials.length > 0) {
    return [];
  }
  return [
    `No AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set, so the judge (${sweep.judge.model}) cannot run. Put one in agent/.env.local.`,
  ];
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

interface JudgeCheck {
  misses: SweepSummary["judgeCheck"]["misses"];
  passed: boolean;
}

/**
 * The judge check runs first in every sweep and stops it on a miss. It arrives
 * with the judge-check eval, so the runner has nothing to run yet.
 */
function runJudgeCheck(): JudgeCheck {
  log("Judge check: not part of this runner yet; the sweep continues.");
  return { misses: [], passed: true };
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
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

interface Cleanup {
  eveStub: EveServer | null;
  pull: PullServer | null;
}

async function runSweep(options: CliOptions): Promise<number> {
  const started = Date.now();
  const cleanup: Cleanup = { eveStub: null, pull: null };
  const abort = { aborted: false };
  const onSignal = (signal: string): void => {
    if (abort.aborted) {
      killAllTracked();
      removeBuilds(root);
      process.exit(130);
    }
    abort.aborted = true;
    console.error(`\n${signal}: stopping. Press Ctrl-C again to quit at once.`);
    killAllTracked();
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
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await cleanup.eveStub?.stop();
    await cleanup.pull?.stop();
    killAllTracked();
    removeBuilds(root);
  }
}

async function sweepBody(
  options: CliOptions,
  cleanup: Cleanup,
  abort: { aborted: boolean },
  started: number
): Promise<number> {
  heading(`Sweep ${options.sweep}${options.dryRun ? " (dry run)" : ""}`);
  const loaded = await loadSweep(options.sweep);
  const { sweep } = loaded;
  statusLine("Model lists replaced from the environment", loaded.overrides);

  const everyone = await loadAllPeople();
  const problems = dataProblems(everyone, EVAL_TODAY);
  if (problems.length > 0) {
    console.error(`The eval data has problems:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  const selected = selectPeople(everyone, sweep.tags);
  if (selected.length === 0) {
    console.error(
      `No person matches the sweep's tags (${sweep.tags.join(", ")}).`
    );
    return 2;
  }
  const peopleById = new Map(selected.map((person) => [person.id, person]));

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
      console.error(message);
      return 2;
    }
    log(`${message} A real run would stop here.`);
  }

  let setups = loaded.setups;
  let plan = buildPlan(setups, selected, sweep);
  for (const line of describePlan(plan)) {
    log(line);
  }

  const sweepId = makeSweepId(options.sweep);
  const runDir = join(agentDir, "evals", ".runs", sweepId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const sweepFile = join(runDir, "sweep.json");
  writeFileSync(sweepFile, resolvedSweepJson(sweep));

  heading("Chat prompts and grade target");
  const { overlays, targetRoot } = await prepareRoots(setups);
  cleanup.eveStub = await startEveServer({
    agentDir,
    logFile: join(runDir, "logs", "grade-target.log"),
    ollamaBaseUrl: `http://${OLLAMA_HOST}/api`,
    root: targetRoot,
    withWorkflowGuard: false,
  });
  log(`Grade target is up at ${cleanup.eveStub.url}`);

  heading("Models and estimate");
  const { bin, pull } = await startOllama();
  cleanup.pull = pull;
  const roles = modelRoles(setups);
  const check = await checkModels(OLLAMA_HOST, roles);
  statusLine("Not pulled yet", check.missing);
  statusLine("Cannot think (think-on setups are skipped)", check.cannotThink);
  if (check.problems.length > 0) {
    console.error(`Model problems:\n  ${check.problems.join("\n  ")}`);
    if (!options.dryRun) {
      return 1;
    }
  }
  const cannotThink = new Set(check.cannotThink);
  setups = withoutImpossibleThinking(setups, cannotThink);
  plan = buildPlan(setups, selected, sweep);

  const book = await loadPriceBook([
    { fallback: DEFAULT_PRICE, id: sweep.judge.model },
    { fallback: DEFAULT_SIMULATED_USER_PRICE, id: sweep.simulatedUser.model },
  ]);
  const estimate = estimateRun({
    dreamMisses: await dreamMissesFor(plan, peopleById),
    history: loadTimingHistory(join(agentDir, "evals", "reports")),
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
  const credentialProblems = spendingNotes(sweep);
  for (const note of credentialProblems) {
    console.error(note);
  }

  if (options.dryRun) {
    log("\nDry run: no models ran, nothing was built or pulled.");
    return 0;
  }
  if (credentialProblems.length > 0) {
    return 2;
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error("Not a terminal, so there is nobody to ask. Pass --yes to run.");
      return 2;
    }
    if (!(await ask("Continue? [y/N] "))) {
      log("Stopped before anything ran.");
      return 0;
    }
  }

  heading("Pulling models");
  for (const model of check.missing) {
    // biome-ignore lint/performance/noAwaitInLoops: pulls run one at a time so the progress is readable.
    await pullModel(bin, OLLAMA_HOST, model);
  }
  if (check.missing.length > 0) {
    const again = await checkModels(OLLAMA_HOST, roles);
    if (again.problems.length > 0 || again.missing.length > 0) {
      console.error(
        `Model problems:\n  ${[...again.problems, ...again.missing.map((model) => `${model} is still not in Ollama.`)].join("\n  ")}`
      );
      return 1;
    }
    for (const model of again.cannotThink) {
      cannotThink.add(model);
    }
    setups = withoutImpossibleThinking(loaded.setups, cannotThink);
    plan = buildPlan(setups, selected, sweep);
  }
  // Sage binds the port itself, so the pull server goes first.
  await pull.stop();
  cleanup.pull = null;

  heading("Building Sage");
  const builds = new Map<Memory, string>();
  for (const memory of plan.memoryValues) {
    // biome-ignore lint/performance/noAwaitInLoops: Zig builds are heavy; one at a time.
    builds.set(
      memory,
      await buildSage({
        logFile: join(runDir, "logs", `build-mem-${memory}.log`),
        memory,
        root,
      })
    );
  }

  const judgeCheck = runJudgeCheck();
  if (!judgeCheck.passed) {
    console.error("The judge check missed:");
    for (const miss of judgeCheck.misses) {
      console.error(`  ${miss.kind} ${miss.check} in ${miss.itemId}: ${miss.detail}`);
    }
    return 1;
  }

  const readSpent = await ledgerReader(runDir);
  const meter = readSpent === null ? null : new CostMeter(readSpent);
  const ctx: RunContext = {
    abort,
    agentDir,
    builds,
    cannotThink,
    credentials: credentialsFrom(),
    failures: [],
    filters: options.eveFilters,
    listCache: new Map(),
    meter,
    ollama: { bin, host: OLLAMA_HOST },
    overlays,
    passesWithFailures: 0,
    people: peopleById,
    pool: new JobPool(MAX_GRADE_PROCESSES),
    prefixes: resolved.prefixes,
    reportsDir: join(agentDir, "evals", "reports"),
    root,
    runDir,
    stubUrl: cleanup.eveStub.url,
    sweep,
    sweepFile,
    sweepId,
  };
  mkdirSync(ctx.reportsDir, { recursive: true });

  heading("Running");
  await runLoop(ctx, plan);
  await ctx.pool.drain();

  heading("Reports");
  const reports = await writeAllReports(ctx, plan, loaded, {
    estimate,
    judgeCheck,
    meter,
    readSpent,
    started,
  });
  const exitCode =
    ctx.failures.length > 0 || ctx.passesWithFailures > 0 ? 1 : 0;
  if (ctx.failures.length > 0) {
    console.error(`\n${ctx.failures.length} problem(s):`);
    for (const failure of ctx.failures) {
      console.error(`  ${failure}`);
    }
  }
  if (reports > 0) {
    offerUpload();
  }
  return exitCode;
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

async function writeAllReports(
  ctx: RunContext,
  plan: RunPlan,
  loaded: LoadedSweep,
  run: {
    estimate: { costUsd: number; hours: number };
    judgeCheck: JudgeCheck;
    meter: CostMeter | null;
    readSpent: (() => number) | null;
    started: number;
  }
): Promise<number> {
  const commit = await gitCommit();
  const peopleIds = plan.people.map((person) => person.id);
  const reports: SetupReport[] = [];
  for (const setup of plan.setups) {
    const id = setupIdOf(setup);
    const data = collectSetupData(
      ctx.runDir,
      { dreamKeyId: dreamKeyId(setup), setupId: id },
      peopleIds
    );
    if (data.rows.length === 0 && data.transcripts.length === 0) {
      continue;
    }
    reports.push(
      assembleSetupReport({
        costUsd: run.meter?.costOf(id) ?? 0,
        gitCommit: commit,
        people: peopleIds,
        promptShas: promptShasFor(setup, ctx.overlays),
        rows: data.rows,
        setup,
        sweep: ctx.sweep,
        sweepId: ctx.sweepId,
        transcripts: data.transcripts,
      })
    );
  }
  const spent = run.readSpent === null ? null : run.readSpent();
  const summary = assembleSweepSummary({
    actual: {
      costUsd: spent,
      hours: (Date.now() - run.started) / 3_600_000,
    },
    estimate: run.estimate,
    judgeCheck: run.judgeCheck,
    reports,
    sweep: ctx.sweep,
    sweepFile: `${loaded.name}.yaml`,
    sweepId: ctx.sweepId,
  });
  const written = writeReports(ctx.reportsDir, reports, summary);
  log(`Wrote ${written.length} file${written.length === 1 ? "" : "s"} to ${ctx.reportsDir}`);
  for (const line of describeRanking(summary, reports)) {
    log(line);
  }
  const actualCost = spent === null ? "unknown" : `$${spent.toFixed(2)}`;
  log(
    `Took ${((Date.now() - run.started) / 3_600_000).toFixed(1)} hours (estimated ${run.estimate.hours.toFixed(1)}). Cloud spending ${actualCost} (estimated $${run.estimate.costUsd.toFixed(2)}).`
  );
  return reports.length;
}

/** The old runner ended by asking about an upload. The script still does the asking. */
function offerUpload(): void {
  spawnSync("sh", [join(root, "scripts", "eval-upload.sh")], {
    cwd: root,
    stdio: "inherit",
  });
}

export { main };
