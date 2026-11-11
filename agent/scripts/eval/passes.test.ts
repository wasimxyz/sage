import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { EVAL_ENV } from "../../evals/lib/schema.ts";
import {
  buildPassEnv,
  ENV_DREAM_KEY,
  ENV_SWEEP_ID,
  evalListArgs,
  evalRunArgs,
  JobPool,
  listEvals,
  MAX_GRADE_PROCESSES,
  PASS_CONCURRENCY,
  type PassEnvInput,
  parseEvalList,
  runEvalPass,
  statusOf,
} from "./passes.ts";
import { fakeEve, tempDir } from "./test-fixtures.ts";

const pattern1 = /token is \[redacted\]/u;

function input(overrides: Partial<PassEnvInput> = {}): PassEnvInput {
  return {
    agentDir: "/repo/agent",
    base: { HOME: "/home/x", PATH: "/usr/bin" },
    credentials: {},
    dataDir: "/tmp/sage-eval-x",
    dataRoot: "/repo/agent/evals/data",
    discoveryFile: "/tmp/sage-eval-x/agent-server.json",
    manifest: "/tmp/sage-eval-x/manifest.json",
    models: { chat: "chat-m", embed: "embed-m", summary: "sum-m" },
    person: "sam-example",
    repoRoot: "/repo",
    results: "/run/setups/s/sam-example/chat.results.jsonl",
    runDir: "/run",
    setupId: "0123456789",
    sweepFile: "/run/sweep.json",
    sweepId: "2026-11-10T031500Z-smoke",
    transcripts: "/run/setups/s/sam-example/transcripts.jsonl",
    ...overrides,
  };
}

test("a pass gets every variable in EVAL_ENV that applies, plus the sweep id", () => {
  const env = buildPassEnv(input());
  assert.equal(env[EVAL_ENV.data], "/repo/agent/evals/data");
  assert.equal(
    env[EVAL_ENV.discoveryFile],
    "/tmp/sage-eval-x/agent-server.json"
  );
  assert.equal(env[EVAL_ENV.manifest], "/tmp/sage-eval-x/manifest.json");
  assert.equal(env[EVAL_ENV.person], "sam-example");
  assert.equal(
    env[EVAL_ENV.results],
    "/run/setups/s/sam-example/chat.results.jsonl"
  );
  assert.equal(env[EVAL_ENV.runDir], "/run");
  assert.equal(env[EVAL_ENV.setupId], "0123456789");
  assert.equal(env[EVAL_ENV.sweepFile], "/run/sweep.json");
  assert.equal(env[EVAL_ENV.today], "2026-11-15");
  assert.equal(
    env[EVAL_ENV.transcripts],
    "/run/setups/s/sam-example/transcripts.jsonl"
  );
  assert.equal(env[ENV_SWEEP_ID], "2026-11-10T031500Z-smoke");
  assert.equal(env.SAGE_DATA_DIR, "/tmp/sage-eval-x");
  assert.equal(env.SAGE_CHAT_MODEL, "chat-m");
  assert.equal(env.EVE_TELEMETRY_DISABLED, "1");
  assert.ok(env.PATH.startsWith(join("/repo/agent", "node_modules", ".bin")));
});

test("the Dream key is set only when there is one, and Dream prompts never reach a pass", () => {
  const plain = buildPassEnv(input());
  assert.equal(plain[ENV_DREAM_KEY], undefined);
  assert.equal(
    buildPassEnv(input({ dreamKey: "abc123" }))[ENV_DREAM_KEY],
    "abc123"
  );
  // Only Sage reads the Dream prompt folder (see sageEnv). A value in the
  // shell that started the runner does not reach the eval clients either.
  const shell = buildPassEnv(
    input({
      base: {
        PATH: "/usr/bin",
        [EVAL_ENV.dreamPrompts]: "/repo/agent/evals/dream-prompts/careful",
      },
    })
  );
  assert.equal(shell[EVAL_ENV.dreamPrompts], undefined);
});

test("the token and the gateway credentials go in only when given", () => {
  const bare = buildPassEnv(
    input({
      base: {
        AI_GATEWAY_API_KEY: "from-shell",
        EVE_EVAL_AUTH_TOKEN: "from-shell",
        PATH: "/bin",
      },
    })
  );
  assert.equal(bare.AI_GATEWAY_API_KEY, undefined);
  assert.equal(bare.EVE_EVAL_AUTH_TOKEN, undefined);
  const full = buildPassEnv(
    input({ credentials: { AI_GATEWAY_API_KEY: "key" }, token: "tok" })
  );
  assert.equal(full.AI_GATEWAY_API_KEY, "key");
  assert.equal(full.EVE_EVAL_AUTH_TOKEN, "tok");
});

test("a pass runs eve eval with the ids, one eval at a time for Chat, the URL, then the filters", () => {
  assert.deepEqual(
    evalRunArgs({
      agentDir: "/repo/agent",
      concurrency: PASS_CONCURRENCY.chat,
      filters: ["--tag", "example"],
      prefixes: ["chat/facts", "chat/openers"],
      url: "http://127.0.0.1:5000",
    }),
    [
      "eval",
      "chat/facts",
      "chat/openers",
      "--max-concurrency",
      "1",
      "--url",
      "http://127.0.0.1:5000",
      "--tag",
      "example",
    ]
  );
  assert.deepEqual(
    evalListArgs({
      agentDir: "/repo/agent",
      filters: ["--tag", "x"],
      prefixes: ["person"],
    }),
    ["eval", "person", "--list", "--json", "--tag", "x"]
  );
  assert.equal(PASS_CONCURRENCY.chat, 1);
  assert.equal(MAX_GRADE_PROCESSES, 2);
});

test("the list in --list --json output can follow other lines", () => {
  const json = JSON.stringify([
    { id: "chat/facts/1" },
    { id: "chat/facts/2", tags: ["x"] },
    { nope: 1 },
  ]);
  assert.deepEqual(parseEvalList(`warning: something\n${json}\n`), [
    "chat/facts/1",
    "chat/facts/2",
  ]);
  assert.deepEqual(parseEvalList("[]"), []);
  assert.equal(parseEvalList("no list here"), null);
  assert.equal(parseEvalList("[not json"), null);
});

test("listEvals reads the ids, and exit 2 means nothing matched", async (t) => {
  const agentDir = tempDir(t);
  fakeEve(
    agentDir,
    `if (process.env.FAKE_EXIT) { console.error('No evals found matching'); process.exit(Number(process.env.FAKE_EXIT)); }
console.log('loading...');
console.log(JSON.stringify([{ id: 'chat/facts/1' }, { id: 'chat/facts/2' }]));`
  );
  const command = { agentDir, filters: [], prefixes: ["chat/facts"] };
  const found = await listEvals(command, { PATH: process.env.PATH ?? "" });
  assert.deepEqual(found, { ids: ["chat/facts/1", "chat/facts/2"], ok: true });
  const none = await listEvals(command, {
    FAKE_EXIT: "2",
    PATH: process.env.PATH ?? "",
  });
  assert.deepEqual(none, { ids: [], ok: true });
  const broken = await listEvals(command, {
    FAKE_EXIT: "1",
    PATH: process.env.PATH ?? "",
  });
  assert.equal(broken.ok, false);
  const nothingAsked = await listEvals({ ...command, prefixes: [] }, {});
  assert.deepEqual(nothingAsked, { ids: [], ok: true });
});

test("runEvalPass tells a failed eval from a crash", async (t) => {
  const agentDir = tempDir(t);
  fakeEve(agentDir, "process.exit(Number(process.env.FAKE_EXIT ?? 0));");
  const command = {
    agentDir,
    concurrency: 1,
    filters: [],
    prefixes: ["chat/facts"],
    url: "http://127.0.0.1:1",
  };
  const run = (code: string) =>
    runEvalPass(command, {
      env: { FAKE_EXIT: code, PATH: process.env.PATH ?? "" },
      logFile: join(agentDir, "pass.log"),
    });
  assert.equal((await run("0")).status, "ok");
  assert.equal((await run("1")).status, "evals-failed");
  assert.equal((await run("2")).status, "crashed");
  assert.equal(
    statusOf({ code: null, durationMs: 1, signal: "SIGKILL" }),
    "crashed"
  );
});

test("a pass's output is logged without the token", async (t) => {
  const agentDir = tempDir(t);
  fakeEve(
    agentDir,
    "console.log('token is ' + process.env.EVE_EVAL_AUTH_TOKEN);"
  );
  const logFile = join(agentDir, "pass.log");
  const token = "tok-0123456789-secret";
  await runEvalPass(
    {
      agentDir,
      concurrency: 1,
      filters: [],
      prefixes: ["grade"],
      url: "http://127.0.0.1:1",
    },
    {
      env: { EVE_EVAL_AUTH_TOKEN: token, PATH: process.env.PATH ?? "" },
      logFile,
      secrets: [token],
    }
  );
  const log = readFileSync(logFile, "utf8");
  assert.match(log, pattern1);
  assert.ok(!log.includes(token));
});

test("JobPool runs up to its limit at once and makes the next job wait", async () => {
  const pool = new JobPool(2);
  let running = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const job = () =>
    new Promise<void>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      releases.push(() => {
        running -= 1;
        resolve();
      });
    });
  await pool.submit(job);
  await pool.submit(job);
  assert.equal(pool.active, 2);

  let thirdStarted = false;
  const third = pool.submit(async () => {
    thirdStarted = true;
    await Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdStarted, false, "the third job waits for a free slot");

  releases[0]?.();
  await third;
  assert.equal(thirdStarted, true);
  releases[1]?.();
  await pool.drain();
  assert.equal(pool.active, 0);
  assert.equal(peak, 2);
  assert.equal(pool.highWater, 2);
});

test("a job that throws does not stop the pool", async () => {
  const pool = new JobPool(1);
  await pool.submit(() => Promise.reject(new Error("boom")));
  let ran = false;
  await pool.submit(async () => {
    ran = true;
    await Promise.resolve();
  });
  await pool.drain();
  assert.equal(ran, true);
});
