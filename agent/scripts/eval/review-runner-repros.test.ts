// Review repros for PR 1 (runner and safety). Each test states the behavior
// the runner should have, and fails on the branch as reviewed.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { loadCacheKeyParts } from "../../evals/lib/cache.ts";
import {
  expandSetups,
  parseSweepFile,
  parseTranscriptRow,
  rankingEntryFor,
  rankSetups,
  type Setup,
  setupId as setupIdOf,
  type TranscriptRow,
} from "../../evals/lib/schema.ts";
import { snapshotDigests } from "./dream.ts";
import { fetchPinnedOllama } from "./ollama.ts";
import { JobPool } from "./passes.ts";
import { buildPlan } from "./plan.ts";
import { hasExited, killAllTracked, sleep, waitFor } from "./proc.ts";
import { assembleSetupReport, type PassRow, summarize } from "./report.ts";
import { prepareDataDir, startSage } from "./sage.ts";
import { fakeEve, makePerson, tempDir } from "./test-fixtures.ts";
import { type RunContext, runPersonUnit } from "./unit.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listen(
  handler: RequestListener
): Promise<{ close: () => Promise<void>; host: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    host: `127.0.0.1:${port}`,
  };
}

async function freeHost(): Promise<string> {
  const server = await listen((_req, res) => res.end());
  await server.close();
  return server.host;
}

function withEnv(t: test.TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Ctrl-C leaves Sage's Ollama running
// ---------------------------------------------------------------------------

// Sage starts Ollama with `.pgid = 0` (src/ollama_server.zig), so Ollama leads
// its own process group, and Sage stops it only from its own quit path. This
// stand-in does the same: a child in a new group, stopped on SIGTERM.
const sageWithOllama = (pidFile: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const ollama = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(ollama.pid));
fs.mkdirSync(".zig-cache/native-sdk-automation", { recursive: true });
fs.writeFileSync("agent-server.json", JSON.stringify({ token: "sage-token-0123456789" }));
process.on("SIGTERM", () => {
  try { process.kill(-ollama.pid, "SIGTERM"); } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

async function startSageWithOllama(
  t: test.TestContext
): Promise<{ ollamaPid: number; run: Awaited<ReturnType<typeof startSage>> }> {
  const dir = tempDir(t);
  const pidFile = join(dir, "ollama.pid");
  const binary = join(dir, "Sage");
  writeFileSync(binary, sageWithOllama(pidFile));
  chmodSync(binary, 0o755);
  const run = await startSage({
    automateWait: () => Promise.resolve(true),
    binary,
    dataDir: prepareDataDir(dir, dir),
    embedModel: "nomic-embed-text",
    ollamaBin: "/none",
    summaryModel: "qwen3.5:9b",
  });
  const ollamaPid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-ollamaPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  return { ollamaPid, run };
}

test("control: a normal stop lets Sage stop its own Ollama", async (t) => {
  const { ollamaPid, run } = await startSageWithOllama(t);
  assert.ok(alive(ollamaPid));
  await run.stop();
  await sleep(300);
  assert.equal(alive(ollamaPid), false);
});

test("REPRO: Ctrl-C (onSignal -> killAllTracked) also stops Sage's Ollama", async (t) => {
  const { ollamaPid, run } = await startSageWithOllama(t);
  assert.ok(alive(ollamaPid));
  // runner.ts onSignal, the exit handler, and the second Ctrl-C all do this.
  killAllTracked();
  await waitFor(() => hasExited(run.child), { timeoutMs: 5000 });
  await sleep(300);
  assert.equal(
    alive(ollamaPid),
    false,
    "Sage got SIGKILL, so its Ollama (own process group) is still running on the port"
  );
});

// ---------------------------------------------------------------------------
// 2. One chat model that cannot load ends the whole unit
// ---------------------------------------------------------------------------

const fakeSageOllama = (calls: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
fs.mkdirSync(".zig-cache/native-sdk-automation", { recursive: true });
fs.writeFileSync("agent-server.json", JSON.stringify({ token: "sage-token-0123456789" }));
const [host, port] = process.env.FAKE_OLLAMA_HOST.split(":");
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (req.url === "/api/generate" && body.model === "too-big:20b" && body.keep_alive === "30m") {
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind: "load-failed", model: body.model }) + "\\n");
      res.statusCode = 500;
      res.end('{"error":"model requires more system memory"}');
      return;
    }
    res.end("{}");
  });
});
server.listen(Number(port), host);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const fakeEveScript = `
const fs = require("node:fs");
const http = require("node:http");
const log = (entry) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(entry) + "\\n");
if (args[0] === "dev") {
  const server = http.createServer((req, res) => res.end("{}"));
  server.listen(0, "127.0.0.1", () => console.log("server listening at http://127.0.0.1:" + server.address().port + "/"));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (args.includes("--list")) {
  console.log(JSON.stringify([{ id: args[1] + "/1" }]));
} else {
  log({ kind: "eval", pass: args[1].split("/")[0], model: process.env.SAGE_CHAT_MODEL });
}
`;

test("REPRO: a chat model that fails to load does not stop the unit's other setups", async (t) => {
  const dir = tempDir(t);
  const agentDir = join(dir, "agent");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  mkdirSync(join(agentDir, "agent", "lib"), { recursive: true });
  writeFileSync(
    join(agentDir, "agent", "lib", "workflow-guard-preload.ts"),
    "export {};\n"
  );
  fakeEve(agentDir, fakeEveScript);
  const overlayRoot = join(agentDir, ".eval-roots", "baseline");
  mkdirSync(overlayRoot, { recursive: true });
  const binary = join(dir, "Sage");
  writeFileSync(binary, fakeSageOllama(calls));
  chmodSync(binary, 0o755);
  const host = await freeHost();
  withEnv(t, { FAKE_CALLS: calls, FAKE_OLLAMA_HOST: host });

  // Two chat models; the first one is too big for the Mac.
  const sweep = parseSweepFile({
    chatModels: ["too-big:20b", "qwen3.5:9b"],
    memory: ["off"],
    tests: ["facts"],
  });
  // An empty journal keeps Dream and the cache out of the way.
  const person = makePerson("sam", { entries: 0 });
  const plan = buildPlan(expandSetups(sweep), [person], sweep);
  const [group] = plan.groups;
  assert.ok(group);
  const ctx: RunContext = {
    abort: { aborted: false },
    agentDir,
    builds: new Map([["off", binary]]),
    cannotThink: new Set(),
    credentials: {},
    digests: () => Promise.resolve({}),
    failures: [],
    filters: [],
    hooks: {
      automateWait: () => Promise.resolve(true),
      seed: (options) => {
        writeFileSync(
          options.manifestPath,
          '{"cases":{"sam":{"journalIds":[]}}}\n'
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
    prefixes: { chat: ["chat/facts"], grade: [], person: [] },
    reportsDir: join(dir, "reports"),
    root: dir,
    runDir: join(dir, "run"),
    stubUrl: "http://127.0.0.1:1",
    sweep,
    sweepFile: join(dir, "run", "sweep.json"),
    sweepId: "2026-11-10T031500Z-smoke",
  };
  mkdirSync(ctx.reportsDir, { recursive: true });
  await runPersonUnit(ctx, group, "sam");
  await ctx.pool.drain();

  const log = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; model?: string });
  assert.ok(log.some((entry) => entry.kind === "load-failed"));
  console.log("recorded failures:", ctx.failures);
  assert.ok(
    log.some((entry) => entry.kind === "eval" && entry.model === "qwen3.5:9b"),
    "qwen3.5:9b never got its chat pass: the load failure of too-big:20b ended the unit"
  );
});

// ---------------------------------------------------------------------------
// 3. The Dream cache key misses the digest of a model pulled in this run
// ---------------------------------------------------------------------------

test("REPRO: the digests the runner keys Dream with include models it pulled", async (t) => {
  let tags: { models: { digest: string; name: string }[] } = { models: [] };
  const server = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(tags));
  });
  t.after(() => server.close());

  // runner.ts inspectModels takes the lookup before pullMissing, and
  // sweepBody hands that same lookup to every unit (ctx.digests).
  const thisRun = await snapshotDigests(["qwen3.5:9b"], server.host);
  // pullModel puts the model in Ollama.
  tags = { models: [{ digest: "sha256:abc", name: "qwen3.5:9b" }] };
  // The next make eval reads the digests fresh.
  const nextRun = await snapshotDigests(["qwen3.5:9b"], server.host);

  const input = {
    dreamPrompt: "baseline",
    embedModel: "qwen3.5:9b",
    memory: "off" as const,
    person: "sam-example",
    summaryModel: "qwen3.5:9b",
  };
  const now = await loadCacheKeyParts(input, thisRun);
  const later = await loadCacheKeyParts(input, nextRun);
  assert.equal(
    now.summaryDigest,
    later.summaryDigest,
    "the snapshot is saved under a no-digest key, so the next run misses it and runs Dream again"
  );
});

// ---------------------------------------------------------------------------
// 4. Counted failures on items that are not graded give a rate of 0
// ---------------------------------------------------------------------------

const baseSetup: Setup = {
  chatModel: "qwen3.5:9b",
  contextLength: 32_768,
  dreamPrompt: "baseline",
  embedModel: "nomic-embed-text",
  memory: "off",
  prompt: "baseline",
  summaryModel: "qwen3.5:9b",
  thinking: "off",
};

function passRow(
  pass: PassRow["pass"],
  itemId: string,
  setup: Setup,
  options: {
    assertions?: PassRow["row"]["assertions"];
    skipReason?: string;
  } = {}
): PassRow {
  return {
    pass,
    row: {
      assertions: options.assertions ?? [],
      completedAt: "2026-11-10T03:00:01.000Z",
      id: itemId,
      metadata: {
        itemId,
        kind: "chat",
        person: "sam",
        repeat: 1,
        setupId: setupIdOf(setup),
      },
      skipReason: options.skipReason,
      startedAt: "2026-11-10T03:00:00.000Z",
      verdict: options.skipReason === undefined ? "passed" : "skipped",
    },
  };
}

function counted(checkId: string, passed: boolean) {
  return {
    metadata: { checkId, tier: "counted" },
    name: `counted:${checkId}`,
    passed,
    score: passed ? 1 : 0,
    severity: "soft",
  };
}

function chatTranscript(
  itemId: string,
  setup: Setup,
  timing: { firstVisibleMs: number | null; totalMs: number } = {
    firstVisibleMs: 2000,
    totalMs: 4000,
  }
): TranscriptRow {
  return parseTranscriptRow({
    ended: "done",
    itemId,
    journal: "own",
    kind: "chat",
    person: "sam",
    repeat: 1,
    setupId: setupIdOf(setup),
    turns: [
      { role: "user", text: "How was my week?" },
      {
        role: "assistant",
        text: "You wrote about the market.",
        timing: { ...timing, toolMs: 0 },
      },
    ],
  });
}

test("REPRO: a setup past the spending cap does not rank first on counted failures it had", () => {
  const sweep = parseSweepFile({});
  // Setup A: the turn failed, and the grade pass hit the spending cap.
  const a: Setup = { ...baseSetup, chatModel: "a:8b" };
  const reportA = assembleSetupReport({
    gitCommit: "abc",
    people: ["sam"],
    promptShas: { chat: "abc", dream: null },
    rows: [
      passRow("chat", "sam/chat/1", a, {
        assertions: [counted("turn-works", false)],
      }),
      // What grade/facts records through recordGraded once the ledger refuses.
      passRow("grade", "sam/chat/1", a, {
        assertions: [
          {
            metadata: {
              checkId: "chat-factuality",
              notGraded: true,
              reason: "not graded: spending cap",
              tier: "soft",
            },
            name: "soft:chat-factuality",
            passed: false,
            score: 0,
            severity: "soft",
          },
        ],
      }),
    ],
    setup: a,
    sweep,
    sweepId: "2026-11-10T031500Z-smoke",
    transcripts: [chatTranscript("sam/chat/1", a)],
  });
  // Setup B: graded in full, one counted failure in two items.
  const b: Setup = { ...baseSetup, chatModel: "b:8b" };
  const reportB = assembleSetupReport({
    gitCommit: "abc",
    people: ["sam"],
    promptShas: { chat: "abc", dream: null },
    rows: [
      passRow("chat", "sam/chat/1", b, {
        assertions: [counted("turn-works", true)],
      }),
      passRow("grade", "sam/chat/1", b, {
        assertions: [counted("journal-right", false)],
      }),
      passRow("chat", "sam/chat/2", b, {
        assertions: [counted("turn-works", true)],
      }),
      passRow("grade", "sam/chat/2", b, {
        assertions: [counted("journal-right", true)],
      }),
    ],
    setup: b,
    sweep,
    sweepId: "2026-11-10T031500Z-smoke",
    transcripts: [
      chatTranscript("sam/chat/1", b),
      chatTranscript("sam/chat/2", b),
    ],
  });
  console.log(
    "A:",
    reportA.summary.countedFailures,
    "failures,",
    reportA.summary.graded,
    "graded, rate",
    reportA.summary.countedRate
  );
  console.log(
    "B:",
    reportB.summary.countedFailures,
    "failures,",
    reportB.summary.graded,
    "graded, rate",
    reportB.summary.countedRate
  );
  const ranked = rankSetups([reportA, reportB].map(rankingEntryFor));
  assert.notEqual(
    ranked[0]?.setupId,
    reportA.setupId,
    "A has a counted failure and nothing graded, yet its counted rate is 0 and it ranks first"
  );
});

// ---------------------------------------------------------------------------
// 5. Turns that never showed a word drop out of the speed check
// ---------------------------------------------------------------------------

test("REPRO: turns that never showed a word still count toward fast-enough", () => {
  const sweep = parseSweepFile({});
  const transcripts = [
    chatTranscript("sam/chat/1", baseSetup, {
      firstVisibleMs: 2000,
      totalMs: 4000,
    }),
    chatTranscript("sam/chat/2", baseSetup, {
      firstVisibleMs: null,
      totalMs: 300_000,
    }),
    chatTranscript("sam/chat/3", baseSetup, {
      firstVisibleMs: null,
      totalMs: 300_000,
    }),
    chatTranscript("sam/chat/4", baseSetup, {
      firstVisibleMs: null,
      totalMs: 300_000,
    }),
  ];
  const summary = summarize([], transcripts, sweep, { costUsd: 0 });
  console.log(
    "median first word (ms):",
    summary.firstWordMedianMs,
    "hard failures:",
    summary.hardFailures
  );
  assert.ok(
    summary.hardFailures.some((failure) => failure.id === "fast-enough"),
    "three of four turns showed nothing for 5 minutes, and the setup passes the 20 s limit"
  );
});

// ---------------------------------------------------------------------------
// 6. fetch-ollama.sh inherits the gateway key
// ---------------------------------------------------------------------------

test("REPRO: fetch-ollama.sh gets no gateway credentials", async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, "scripts"), { recursive: true });
  const seen = join(root, "seen.txt");
  writeFileSync(
    join(root, "scripts", "fetch-ollama.sh"),
    `printf '%s' "\${AI_GATEWAY_API_KEY:-}" > ${JSON.stringify(seen)}\necho /none/ollama\n`
  );
  // main() runs loadEvalEnv first, which copies agent/.env.local into process.env.
  withEnv(t, { AI_GATEWAY_API_KEY: "gw-key-0123456789abcdef" });
  assert.equal(await fetchPinnedOllama(root), "/none/ollama");
  assert.equal(
    readFileSync(seen, "utf8"),
    "",
    "the gateway key reached fetch-ollama.sh"
  );
});
