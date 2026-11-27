// A whole unit with stand-ins: a fake Sage (which also plays Ollama), a fake
// `eve` (which serves health, lists evals, and writes result rows the way the
// eval files do), and a hook for the seed step. It checks the order of the
// steps, what each process is given, and what is left behind.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { cachedDreamEntry } from "../../evals/lib/cache.ts";
import {
  dreamKeyId,
  expandSetups,
  parseSweepFile,
  setupId as setupIdOf,
} from "../../evals/lib/schema.ts";
import { collectSetupData } from "./collect.ts";
import { OLLAMA_HOST } from "./ollama.ts";
import { JobPool } from "./passes.ts";
import { buildPlan } from "./plan.ts";
import { assembleSetupReport } from "./report.ts";
import {
  fakeEve,
  makePerson,
  tempDir,
  writeCacheKeyFiles,
} from "./test-fixtures.ts";
import { type RunContext, runPersonUnit } from "./unit.ts";

const tooBigFailurePattern =
  /too-big:20b .* could not start: Ollama could not load too-big:20b \(HTTP 500\)/u;
const unitFailedPattern = /mem off .* failed:/u;
const couldNotLoadPattern = /Ollama could not load too-big:20b/u;
const evalRootsBaselinePattern = /\.eval-roots\/baseline$/u;
const f0Pattern = /^[a-f0-9]{64}$/u;
const carefulStampPattern = /"dreamPrompt": "careful"/u;
const fakeSageIsUpPattern = /fake sage is up/u;
const samFailedSageAutomationPattern =
  /sam .* failed: Sage automation did not become ready/u;

const envNames = [
  "AI_GATEWAY_API_KEY",
  "FAKE_CALLS",
  "FAKE_OLLAMA_FAIL_MODEL",
  "FAKE_OLLAMA_HOST",
  "FAKE_OLLAMA_LOG",
  "SAGE_EVAL_CACHE",
  "SAGE_EVAL_CACHE_DIR",
  "SAGE_EVAL_DATA",
  "SAGE_EVAL_DREAM_PROMPTS",
  "SAGE_REPO_ROOT",
] as const;

const fakeSageScript = (calls: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
fs.mkdirSync(".zig-cache/native-sdk-automation", { recursive: true });
fs.writeFileSync("agent-server.json", JSON.stringify({ socket: "/tmp/x.sock", token: "sage-token-0123456789" }));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind: "sage", cwd: process.cwd(), dataDir: process.env.SAGE_DATA_DIR, dreamPrompts: process.env.SAGE_EVAL_DREAM_PROMPTS ?? null, gateway: process.env.AI_GATEWAY_API_KEY ?? null }) + "\\n");
const [host, port] = process.env.FAKE_OLLAMA_HOST.split(":");
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/api/generate") {
      const text = Buffer.concat(chunks).toString("utf8");
      fs.appendFileSync(process.env.FAKE_OLLAMA_LOG, text + "\\n");
      const body = JSON.parse(text);
      if (body.model === process.env.FAKE_OLLAMA_FAIL_MODEL && body.keep_alive === "30m") {
        res.statusCode = 500;
        res.end('{"error":"model requires more system memory"}');
        return;
      }
    }
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});
server.listen(Number(port), host, () => console.log("fake sage is up"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const fakeEveScript = `
const fs = require("node:fs");
const http = require("node:http");
const log = (entry) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(entry) + "\\n");
const now = new Date().toISOString();
const setupId = process.env.SAGE_EVAL_SETUP_ID;
const person = process.env.SAGE_EVAL_PERSON;
const row = (itemId, kind, assertions) => JSON.stringify({ id: itemId, metadata: { itemId, kind, person, repeat: 1, setupId }, assertions, startedAt: now, completedAt: now, verdict: "passed" }) + "\\n";
const check = (tier, checkId, passed, extra = {}) => ({ name: tier + ":" + checkId, passed, score: passed ? 1 : 0, severity: tier === "hard" ? "gate" : "soft", metadata: { checkId, tier, ...extra } });
if (args[0] === "dev") {
  const server = http.createServer((req, res) => res.end(req.url === "/eve/v1/health" ? '{"ok":true}' : "{}"));
  server.listen(0, "127.0.0.1", () => {
    console.log("[DEV] server listening at http://127.0.0.1:" + server.address().port + "/");
    log({ kind: "dev", cwd: process.cwd(), token: process.env.EVE_EVAL_AUTH_TOKEN ?? null, gateway: process.env.AI_GATEWAY_API_KEY ?? null, discovery: process.env.SAGE_DISCOVERY_FILE, dreamPrompts: process.env.SAGE_EVAL_DREAM_PROMPTS ?? null, today: process.env.SAGE_TODAY, ollama: process.env.OLLAMA_BASE_URL, port: server.address().port });
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (args[0] === "eval") {
  const prefix = args[1];
  if (args.includes("--list")) {
    console.log("loading evals");
    console.log(JSON.stringify([{ id: prefix + "/1" }]));
    process.exit(0);
  }
  const pass = prefix.split("/")[0];
  const dreamKey = process.env.SAGE_EVAL_DREAM_KEY ?? null;
  const cacheFolder = dreamKey === null ? null : fs.existsSync(require("node:path").join(process.env.SAGE_EVAL_CACHE_DIR, dreamKey));
  log({ kind: "eval", pass, prefixes: args.slice(1, args.indexOf("--max-concurrency")), chatModel: process.env.SAGE_CHAT_MODEL ?? null, url: args[args.indexOf("--url") + 1], concurrency: args[args.indexOf("--max-concurrency") + 1], token: process.env.EVE_EVAL_AUTH_TOKEN ?? null, gateway: process.env.AI_GATEWAY_API_KEY ?? null, setupId, person, dreamKey, cacheFolder, manifest: process.env.SAGE_EVAL_MANIFEST ?? null, dreamPrompts: process.env.SAGE_EVAL_DREAM_PROMPTS ?? null, sweepId: process.env.SAGE_EVAL_SWEEP_ID, runDir: process.env.SAGE_EVAL_RUN_DIR, dataDir: process.env.SAGE_DATA_DIR, discovery: process.env.SAGE_DISCOVERY_FILE, transcripts: process.env.SAGE_EVAL_TRANSCRIPTS });
  if (pass === "person") {
    fs.appendFileSync(process.env.SAGE_EVAL_RESULTS, row(person + "/retrieval/1", "retrieval", [check("counted", "retrieval-top-hit", true)]));
  } else if (pass === "chat") {
    const itemId = person + "/chat/1";
    fs.appendFileSync(process.env.SAGE_EVAL_TRANSCRIPTS, JSON.stringify({ ended: "done", itemId, journal: "own", kind: "chat", person, repeat: 1, setupId, turns: [{ role: "user", text: "How was my week?" }, { role: "assistant", text: "You wrote about the market.", timing: { firstVisibleMs: 2000, toolMs: 0, totalMs: 4000 } }] }) + "\\n");
    fs.appendFileSync(process.env.SAGE_EVAL_RESULTS, row(itemId, "chat", [check("counted", "turn-works", true)]));
  } else if (pass === "grade") {
    const itemId = person + "/chat/1";
    const transcripts = fs.readFileSync(process.env.SAGE_EVAL_TRANSCRIPTS, "utf8").trim().split("\\n").length;
    fs.appendFileSync(process.env.SAGE_EVAL_RESULTS, row(itemId, "chat", [
      check("counted", "journal-right", transcripts === 1, { judgeCallId: "call-" + setupId, judgeCostUsd: 0.05, turnIndex: 1 }),
      { name: "rubric:warmth", score: 0.75, severity: "soft", metadata: { checkId: "warmth", tier: "rubric", turnIndex: 1, rubric: "rubrichash12" } },
    ]));
  }
}
`;

interface Call {
  chatModel?: string | null;
  cwd?: string;
  dataDir?: string;
  dreamKey?: string | null;
  gateway?: string | null;
  kind: string;
  pass?: string;
  person?: string;
  port?: number;
  setupId?: string;
  token?: string | null;
  url?: string;
  [key: string]: unknown;
}

/** macOS reaches the temp dir through /var; a process's cwd shows /private/var. */
function withoutPrivate(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

function readCalls(path: string): Call[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Rig {
  cacheDir: string;
  calls: string;
  ctx: RunContext;
  group: ReturnType<typeof buildPlan>["groups"][number];
  ollamaLog: string;
  plan: ReturnType<typeof buildPlan>;
  repo: string;
  runDir: string;
  seeded: { count: number };
}

interface RigOptions {
  /** False for a sweep that sends no Chat message. */
  chat?: boolean;
  /** A model the fake Ollama refuses to load. */
  failModel?: string;
  /** The eval ids each pass runs. */
  prefixes?: RunContext["prefixes"];
  sweep?: Record<string, unknown>;
}

async function makeRig(
  t: test.TestContext,
  rigOptions: RigOptions = {}
): Promise<Rig> {
  const dir = tempDir(t);
  const repo = join(dir, "repo");
  const agentDir = join(repo, "agent");
  const dataRoot = join(dir, "data");
  const runDir = join(dir, "run");
  const reportsDir = join(dir, "reports");
  const calls = join(dir, "calls.jsonl");
  const ollamaLog = join(dir, "ollama.jsonl");
  for (const path of [calls, ollamaLog]) {
    writeFileSync(path, "");
  }
  const host = `127.0.0.1:${await freePort()}`;

  // The cache key reads the Dream source files and the person's entries.
  mkdirSync(join(repo, "src", "schema"), { recursive: true });
  writeCacheKeyFiles(repo);
  writeFileSync(
    join(repo, "src", "schema", "0001.sql"),
    "CREATE TABLE t (id INTEGER);\n"
  );
  writeFileSync(join(repo, "app.json"), "{}\n");
  mkdirSync(join(dataRoot, "people", "sam"), { recursive: true });
  writeFileSync(join(dataRoot, "people", "sam", "2026-06-01-one.md"), "one\n");

  // The workflow guard the Chat server preloads has to exist.
  mkdirSync(join(agentDir, "agent", "lib"), { recursive: true });
  writeFileSync(
    join(agentDir, "agent", "lib", "workflow-guard-preload.ts"),
    "export {};\n"
  );
  fakeEve(agentDir, fakeEveScript);
  const overlayRoot = join(agentDir, ".eval-roots", "baseline");
  mkdirSync(overlayRoot, { recursive: true });
  const sageBinary = join(dir, "Sage");
  writeFileSync(sageBinary, fakeSageScript(calls));
  chmodSync(sageBinary, 0o755);

  const previous = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, {
    AI_GATEWAY_API_KEY: "gateway-key-0123456789",
    FAKE_CALLS: calls,
    FAKE_OLLAMA_HOST: host,
    FAKE_OLLAMA_LOG: ollamaLog,
    SAGE_EVAL_CACHE_DIR: join(dir, "cache"),
    SAGE_EVAL_DATA: dataRoot,
    SAGE_REPO_ROOT: repo,
  });
  delete process.env.SAGE_EVAL_CACHE;
  delete process.env.SAGE_EVAL_DREAM_PROMPTS;
  if (rigOptions.failModel === undefined) {
    delete process.env.FAKE_OLLAMA_FAIL_MODEL;
  } else {
    process.env.FAKE_OLLAMA_FAIL_MODEL = rigOptions.failModel;
  }
  t.after(() => {
    for (const name of envNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  });

  const sweep = parseSweepFile(
    rigOptions.sweep ?? { memory: ["off"], tests: ["person", "facts"] }
  );
  const setups = expandSetups(sweep);
  const person = makePerson("sam", { entries: 1 });
  const plan = buildPlan(setups, [person], sweep, {
    chat: rigOptions.chat ?? true,
  });
  const [group] = plan.groups;
  assert.ok(group);
  const seeded = { count: 0 };
  const ctx: RunContext = {
    abort: { aborted: false },
    agentDir,
    builds: new Map([["off", sageBinary]]),
    cannotThink: new Set(),
    credentials: { AI_GATEWAY_API_KEY: "gateway-key-0123456789" },
    digests: () =>
      Promise.resolve({
        "nomic-embed-text": "sha256:e",
        "qwen3.5:9b": "sha256:s",
      }),
    failures: [],
    filters: [],
    hooks: {
      automateWait: () => Promise.resolve(true),
      seed: (options) => {
        seeded.count += 1;
        const db = new DatabaseSync(join(options.dataDir, "app.db"));
        db.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE memory (n INTEGER); INSERT INTO memory VALUES (1);"
        );
        db.close();
        writeFileSync(
          options.manifestPath,
          '{"cases":{"sam":{"journalIds":[1]}}}\n'
        );
        return Promise.resolve();
      },
    },
    listCache: new Map(),
    ollama: { bin: "/none", host },
    overlays: new Map([
      ["baseline", { prompt: "baseline", promptSha: "abc", root: overlayRoot }],
    ]),
    passesWithFailures: 0,
    people: new Map([["sam", person]]),
    pool: new JobPool(2),
    prefixes: rigOptions.prefixes ?? {
      chat: ["chat/facts"],
      grade: ["grade/replies"],
      person: ["person/retrieval"],
    },
    reportsDir,
    root: repo,
    runDir,
    stubUrl: "http://127.0.0.1:1",
    sweep,
    sweepFile: join(runDir, "sweep.json"),
    sweepId: "2026-11-10T031500Z-smoke",
  };
  mkdirSync(reportsDir, { recursive: true });
  return {
    cacheDir: join(dir, "cache"),
    calls,
    ctx,
    group,
    ollamaLog,
    plan,
    repo,
    runDir,
    seeded,
  };
}

test("a unit seeds, runs the person pass, chats against the overlay server, and grades in the background", async (t) => {
  const rig = await makeRig(t);
  const { ctx } = rig;
  await runPersonUnit(ctx, rig.group, "sam");
  await ctx.pool.drain();
  assert.deepEqual(ctx.failures, []);
  assert.equal(ctx.passesWithFailures, 0);
  assert.equal(rig.seeded.count, 1);

  const calls = readCalls(rig.calls);
  const sage = calls.find((call) => call.kind === "sage");
  const dev = calls.find((call) => call.kind === "dev");
  const person = calls.find((call) => call.pass === "person");
  const chat = calls.find((call) => call.pass === "chat");
  const grade = calls.find((call) => call.pass === "grade");
  assert.ok(sage && dev && person && chat && grade);

  // The order: Sage, the person pass, the Chat server, then chat, then grade.
  const kinds = calls.map((call) => call.pass ?? call.kind);
  assert.deepEqual(
    kinds.filter((kind) => kind !== "grade"),
    ["sage", "person", "dev", "chat"]
  );
  assert.ok(kinds.indexOf("grade") > kinds.indexOf("chat"));

  // Sage got its folder and no credentials.
  // The folder is under the temp dir, which macOS reaches through a symlink.
  assert.equal(withoutPrivate(String(sage.cwd)), sage.dataDir);
  assert.equal(sage.gateway, null);

  // The Chat server runs from the overlay, reads Sage's discovery file, holds no secret.
  assert.match(String(dev.cwd), evalRootsBaselinePattern);
  assert.equal(dev.discovery, join(String(sage.dataDir), "agent-server.json"));
  assert.equal(dev.token, null);
  assert.equal(dev.gateway, null);
  assert.equal(dev.today, "2026-11-15");
  assert.equal(dev.ollama, `http://${ctx.ollama.host}/api`);

  // Person and grade passes go to the stub target. Chat goes to the overlay server, with the token.
  assert.equal(person.url, ctx.stubUrl);
  assert.equal(grade.url, ctx.stubUrl);
  assert.equal(chat.url, `http://127.0.0.1:${dev.port}`);
  assert.equal(chat.token, "sage-token-0123456789");
  assert.equal(person.token, null);
  assert.equal(grade.token, null);
  for (const pass of [person, chat, grade]) {
    assert.equal(pass.gateway, "gateway-key-0123456789");
    assert.equal(pass.person, "sam");
    assert.equal(pass.sweepId, ctx.sweepId);
    assert.equal(pass.runDir, ctx.runDir);
    assert.equal(pass.dataDir, sage.dataDir);
  }
  assert.equal(chat.concurrency, "1");
  const setup = ctx.sweep && expandSetups(ctx.sweep)[0];
  assert.ok(setup);
  assert.equal(chat.setupId, setupIdOf(setup));

  // Only the person pass gets the Dream key, which is the snapshot's key.
  assert.match(String(person.dreamKey), f0Pattern);
  assert.equal(chat.dreamKey, null);
  assert.equal(grade.dreamKey, null);
  assert.ok(
    cachedDreamEntry(String(person.dreamKey), join(rig.runDir, "..", "cache"))
  );

  // Ollama was asked to load the chat model at the setup's context length, and to unload models after.
  const asked = readFileSync(rig.ollamaLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(asked[0], { keep_alive: 0, model: "qwen3.5:9b" });
  assert.ok(
    asked.some(
      (body) => body.options?.num_ctx === 32_768 && body.keep_alive === "30m"
    )
  );
  assert.deepEqual(asked.at(-1), { keep_alive: 0, model: "qwen3.5:9b" });

  // The throwaway folder is gone once grading is done, and its log and manifest were kept.
  assert.equal(existsSync(String(sage.cwd)), false);
  const stem = `${ctx.sweepId}__${rig.group.dreamKeyId}__sam`;
  assert.ok(existsSync(join(ctx.reportsDir, `${stem}.sage.log`)));
  assert.ok(existsSync(join(ctx.reportsDir, `${stem}.manifest.json`)));
  assert.match(
    readFileSync(join(ctx.reportsDir, `${stem}.sage.log`), "utf8"),
    fakeSageIsUpPattern
  );

  // What the passes wrote makes a complete report.
  const data = collectSetupData(
    ctx.runDir,
    { dreamKeyId: dreamKeyId(setup), setupId: setupIdOf(setup) },
    ["sam"]
  );
  assert.deepEqual(data.rows.map((entry) => entry.pass).sort(), [
    "chat",
    "grade",
    "person",
  ]);
  const report = assembleSetupReport({
    gitCommit: "abc",
    people: ["sam"],
    promptShas: { chat: "abc", dream: null },
    rows: data.rows,
    setup,
    sweep: ctx.sweep,
    sweepId: ctx.sweepId,
    transcripts: data.transcripts,
  });
  assert.equal(report.items.length, 2);
  assert.equal(report.summary.graded, 2);
  assert.equal(report.summary.notGraded, 0);
  assert.equal(report.summary.firstWordMedianMs, 2000);
  assert.deepEqual(report.summary.hardFailures, []);
  assert.ok(Math.abs(report.summary.costUsd - 0.05) < 1e-9);
  assert.equal(report.promptShas.rubric, "rubrichash12");
  const chatItem = report.items.find((item) => item.kind === "chat");
  assert.equal(chatItem?.turns[1]?.rubric[0]?.id, "warmth");
  assert.equal(chatItem?.turns[1]?.checks[0]?.outcome, "pass");
});

test("a chat model that will not load fails its own setup, and the unit's other setups still run", async (t) => {
  const rig = await makeRig(t, {
    failModel: "too-big:20b",
    sweep: {
      chatModels: ["too-big:20b", "qwen3.5:9b"],
      memory: ["off"],
      tests: ["person", "facts"],
    },
  });
  const { ctx } = rig;
  await runPersonUnit(ctx, rig.group, "sam");
  await ctx.pool.drain();

  // One recorded problem, naming the setup and the reason. Exit code 1 follows.
  assert.equal(ctx.failures.length, 1);
  assert.match(ctx.failures[0] ?? "", tooBigFailurePattern);
  assert.doesNotMatch(ctx.failures[0] ?? "", unitFailedPattern);

  // The second model got its chat pass and its grade pass. The first got neither.
  const calls = readCalls(rig.calls);
  const chats = calls.filter((call) => call.pass === "chat");
  assert.deepEqual(
    chats.map((call) => call.chatModel),
    ["qwen3.5:9b"]
  );
  assert.equal(calls.filter((call) => call.pass === "grade").length, 1);
  assert.equal(
    calls.filter((call) => call.kind === "sage").length,
    1,
    "one Sage for the whole unit"
  );

  // The failed setup still has a report: one failed Turn works, with the reason.
  const [tooBig, fits] = expandSetups(ctx.sweep);
  assert.ok(tooBig && fits);
  const reportFor = (setup: typeof tooBig) => {
    const data = collectSetupData(
      ctx.runDir,
      { dreamKeyId: dreamKeyId(setup), setupId: setupIdOf(setup) },
      ["sam"]
    );
    return assembleSetupReport({
      gitCommit: "abc",
      people: ["sam"],
      promptShas: { chat: "abc", dream: null },
      rows: data.rows,
      setup,
      sweep: ctx.sweep,
      sweepId: ctx.sweepId,
      transcripts: data.transcripts,
    });
  };
  const failed = reportFor(tooBig);
  assert.equal(
    failed.items.length,
    2,
    "the person pass row and the failed chat"
  );
  const failedChat = failed.items.find((item) => item.kind === "chat");
  assert.deepEqual(
    failedChat?.checks.map((check) => `${check.id}:${check.outcome}`),
    ["turn-works:fail"]
  );
  assert.match(failedChat?.checks[0]?.reason ?? "", couldNotLoadPattern);
  assert.equal(failed.summary.countedFailures, 1);
  const worked = reportFor(fits);
  assert.equal(worked.summary.countedFailures, 0);
  assert.equal(worked.summary.graded, 2);
});

test("a second unit with the same inputs restores the Dream snapshot instead of seeding", async (t) => {
  const rig = await makeRig(t);
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  assert.equal(rig.seeded.count, 1);
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  assert.deepEqual(rig.ctx.failures, []);
  assert.equal(rig.seeded.count, 1, "the cache answered the second time");
  const sages = readCalls(rig.calls).filter((call) => call.kind === "sage");
  assert.equal(sages.length, 2, "each unit still gets its own Sage");
  assert.notEqual(sages[0]?.cwd, sages[1]?.cwd);
});

test("a unit whose Sage will not start is a recorded failure, not a crash", async (t) => {
  const rig = await makeRig(t);
  rig.ctx.hooks = {
    automateWait: () => Promise.resolve(false),
    seed: rig.ctx.hooks?.seed,
  };
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  assert.equal(rig.ctx.failures.length, 1);
  assert.match(rig.ctx.failures[0] ?? "", samFailedSageAutomationPattern);
  assert.equal(rig.seeded.count, 0);
  const left = readdirSync(rig.runDir);
  assert.ok(left.includes("dream"));
});

test("an eve filter that matches nothing skips the unit before Sage starts", async (t) => {
  const rig = await makeRig(t);
  fakeEve(
    rig.ctx.agentDir,
    "console.error('No evals matched the provided tags'); process.exit(2);"
  );
  await runPersonUnit(rig.ctx, rig.group, "sam");
  assert.deepEqual(rig.ctx.failures, []);
  assert.equal(readFileSync(rig.calls, "utf8"), "", "no Sage, no passes");
});

test("a unit stops between steps when the run is aborted", async (t) => {
  const rig = await makeRig(t);
  rig.ctx.abort.aborted = true;
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  const kinds = readCalls(rig.calls).map((call) => call.pass ?? call.kind);
  assert.deepEqual(
    kinds,
    ["sage"],
    "Sage started and stopped, and no pass ran"
  );
  assert.equal(rig.ctx.failures.length, 0);
});

test("the Ollama host of a real run is the dev port", () => {
  assert.equal(OLLAMA_HOST, "127.0.0.1:11436");
});

// ---------------------------------------------------------------------------
// Dream accuracy and Dream prompts
// ---------------------------------------------------------------------------

const dreamOnly = {
  chat: false,
  prefixes: {
    chat: [],
    grade: [],
    person: ["person/retrieval", "person/dream-accuracy"],
  },
  sweep: { memory: ["off"], tests: ["person", "dream-accuracy"] },
} satisfies RigOptions;

test("a Dream-only unit runs Dream accuracy in the person pass with the key, the manifest, and the snapshot's folder, and starts no Chat", async (t) => {
  const rig = await makeRig(t, dreamOnly);
  const { ctx } = rig;
  await runPersonUnit(ctx, rig.group, "sam");
  await ctx.pool.drain();
  assert.deepEqual(ctx.failures, []);
  assert.equal(ctx.passesWithFailures, 0);

  const calls = readCalls(rig.calls);
  assert.deepEqual(
    calls.map((call) => call.pass ?? call.kind),
    ["sage", "person"],
    "no Chat server, no chat pass, no grade pass"
  );
  const sage = calls.find((call) => call.kind === "sage");
  const person = calls.find((call) => call.pass === "person");
  assert.ok(sage && person);

  // The person pass runs both evals, on the stub target, with what Dream accuracy reads.
  assert.deepEqual(person.prefixes, [
    "person/retrieval",
    "person/dream-accuracy",
  ]);
  assert.equal(person.url, ctx.stubUrl);
  assert.equal(person.gateway, "gateway-key-0123456789");
  assert.equal(person.dataDir, sage.dataDir);
  assert.equal(person.manifest, join(String(sage.dataDir), "manifest.json"));
  assert.match(String(person.dreamKey), f0Pattern);

  // The folder for the grades is the snapshot's own, and it was there before the pass.
  assert.equal(person.cacheFolder, true);
  assert.ok(cachedDreamEntry(String(person.dreamKey), rig.cacheDir));

  // Chat's model was never loaded: Ollama only saw the summary model unload.
  const asked = readFileSync(rig.ollamaLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(asked.every((body) => body.keep_alive === 0));
});

test("a second Dream-only unit finds the same snapshot folder for its grades", async (t) => {
  const rig = await makeRig(t, dreamOnly);
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await runPersonUnit(rig.ctx, rig.group, "sam");
  assert.deepEqual(rig.ctx.failures, []);
  assert.equal(rig.seeded.count, 1);
  const people = readCalls(rig.calls).filter((call) => call.pass === "person");
  assert.equal(people.length, 2);
  assert.equal(people[0]?.dreamKey, people[1]?.dreamKey);
  assert.deepEqual(
    people.map((call) => call.cacheFolder),
    [true, true]
  );
});

test("when the snapshot was not saved the runner leaves the folder alone, so the next snapshot of that key can still be made", async (t) => {
  const rig = await makeRig(t, dreamOnly);
  const { ctx } = rig;
  // A seed that leaves no manifest, so the snapshot fails with a warning.
  ctx.hooks = {
    automateWait: () => Promise.resolve(true),
    seed: (options) => {
      const db = new DatabaseSync(join(options.dataDir, "app.db"));
      db.exec("CREATE TABLE memory (n INTEGER);");
      db.close();
      return Promise.resolve();
    },
  };
  await runPersonUnit(ctx, rig.group, "sam");
  assert.deepEqual(ctx.failures, []);
  const person = readCalls(rig.calls).find((call) => call.pass === "person");
  assert.ok(person);
  assert.match(String(person.dreamKey), f0Pattern);
  assert.equal(person.cacheFolder, false);
  // A folder holding only grades would stop the snapshot from ever being moved in.
  assert.equal(existsSync(join(rig.cacheDir, String(person.dreamKey))), false);
});

test("with the cache off the person pass still runs, nothing is made for the grades, and the runner says so once", async (t) => {
  const rig = await makeRig(t, dreamOnly);
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    lines.push(String(line));
  });
  process.env.SAGE_EVAL_CACHE = "0";
  await runPersonUnit(rig.ctx, rig.group, "sam");
  assert.deepEqual(rig.ctx.failures, []);
  const person = readCalls(rig.calls).find((call) => call.pass === "person");
  assert.ok(person);
  assert.equal(person.cacheFolder, false);
  assert.equal(existsSync(rig.cacheDir), false);
  const notes = lines.filter((line) => line.includes("the cache is off"));
  assert.equal(notes.length, 1);
  assert.ok(notes[0]?.includes("SAGE_EVAL_CACHE=0"));
  assert.ok(notes[0]?.includes("grades will not be kept"));
});

test("with the cache on the runner does not say the cache is off", async (t) => {
  const rig = await makeRig(t, dreamOnly);
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    lines.push(String(line));
  });
  await runPersonUnit(rig.ctx, rig.group, "sam");
  assert.deepEqual(rig.ctx.failures, []);
  assert.equal(
    lines.some((line) => line.includes("the cache is off")),
    false
  );
});

test("a Dream prompt variant reaches Sage and no other process", async (t) => {
  const rig = await makeRig(t, {
    sweep: {
      dreamPrompts: ["careful"],
      memory: ["off"],
      tests: ["person", "facts"],
    },
  });
  const folder = join(rig.repo, "agent", "evals", "dream-prompts", "careful");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "summary.md"), "Summarize with care.\n");
  // A value in the shell that started the runner reaches nothing either.
  process.env.SAGE_EVAL_DREAM_PROMPTS = "/stray/prompts";

  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  assert.deepEqual(rig.ctx.failures, []);

  const calls = readCalls(rig.calls);
  const sage = calls.find((call) => call.kind === "sage");
  assert.equal(sage?.dreamPrompts, folder);
  const others = calls.filter((call) => call.kind !== "sage");
  assert.deepEqual(
    others.map((call) => call.pass ?? call.kind),
    ["person", "dev", "chat", "grade"]
  );
  for (const call of others) {
    assert.equal(call.dreamPrompts, null, String(call.pass ?? call.kind));
  }
  // The key is made from the prompt's text.
  const person = calls.find((call) => call.pass === "person");
  assert.ok(person);
  assert.ok(cachedDreamEntry(String(person.dreamKey), rig.cacheDir));
  assert.match(
    readFileSync(
      join(rig.cacheDir, String(person.dreamKey), "key.json"),
      "utf8"
    ),
    carefulStampPattern
  );
});

test("the built-in prompts mean Sage is given no Dream prompt folder, even when the shell has one", async (t) => {
  const rig = await makeRig(t);
  process.env.SAGE_EVAL_DREAM_PROMPTS = "/stray/prompts";
  await runPersonUnit(rig.ctx, rig.group, "sam");
  await rig.ctx.pool.drain();
  const calls = readCalls(rig.calls);
  assert.equal(calls.find((call) => call.kind === "sage")?.dreamPrompts, null);
  for (const call of calls) {
    assert.equal(call.dreamPrompts, null, String(call.pass ?? call.kind));
  }
});
