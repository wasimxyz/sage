import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  EVAL_TODAY,
  EVE_DEV_ARGS,
  eveBin,
  eveDevEnv,
  healthOk,
  parseListeningPort,
  startEveServer,
  workflowGuardPreload,
} from "./eve.ts";
import { fakeEve, tempDir } from "./test-fixtures.ts";

const pattern1 = /^http:\/\/127\.0\.0\.1:\d+$/u;
const pattern2 = /root$/u;
const pattern3 = /workflow-guard-preload\.ts/u;
const pattern4 = /did not report a port[\s\S]*cannot start: no such agent/u;

const agentDir = "/repo/agent";

test("the server environment carries the discovery file, today, and the Ollama address", () => {
  const env = eveDevEnv({
    agentDir,
    base: { PATH: "/usr/bin" },
    discoveryFile: "/tmp/x/agent-server.json",
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    withWorkflowGuard: false,
  });
  assert.equal(env.SAGE_DISCOVERY_FILE, "/tmp/x/agent-server.json");
  assert.equal(env.SAGE_TODAY, EVAL_TODAY);
  assert.equal(env.OLLAMA_BASE_URL, "http://127.0.0.1:11436/api");
  assert.equal(env.EVE_TELEMETRY_DISABLED, "1");
  assert.equal(env.PATH, `${join(agentDir, "node_modules", ".bin")}:/usr/bin`);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("the workflow guard loads ahead of the server, after any options already set", () => {
  const env = eveDevEnv({
    agentDir,
    base: { NODE_OPTIONS: "--max-old-space-size=4096", PATH: "/usr/bin" },
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    withWorkflowGuard: true,
  });
  assert.equal(
    env.NODE_OPTIONS,
    `--max-old-space-size=4096 --import="${workflowGuardPreload(agentDir)}"`
  );
  assert.equal(
    workflowGuardPreload(agentDir),
    join(agentDir, "agent", "lib", "workflow-guard-preload.ts")
  );
  assert.equal(env.SAGE_DISCOVERY_FILE, undefined);
});

test("eveBin points at the installed eve", () => {
  assert.equal(eveBin(agentDir), join(agentDir, "node_modules", ".bin", "eve"));
  assert.equal(EVE_DEV_ARGS[0], "dev");
});

test("parseListeningPort reads eve's line", () => {
  assert.equal(
    parseListeningPort(
      "☰eve v0.80.1\n[DEV] server listening at http://127.0.0.1:54739/\n"
    ),
    54_739
  );
  assert.equal(parseListeningPort("[DEV] starting"), null);
  assert.equal(
    parseListeningPort("server listening at http://0.0.0.0:80/"),
    null
  );
});

const serverScript = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/eve/v1/health") {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/env") {
    const keys = ["SAGE_DISCOVERY_FILE", "NODE_OPTIONS", "EVE_EVAL_AUTH_TOKEN", "AI_GATEWAY_API_KEY", "SAGE_TODAY"];
    res.end(JSON.stringify({ args, cwd: process.cwd(), env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])) }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log("[DEV] server listening at http://127.0.0.1:" + server.address().port + "/");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

test("startEveServer runs eve dev from the root, waits for health, and stops it", async (t) => {
  const dir = tempDir(t);
  fakeEve(dir, serverScript);
  const root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  // The server preloads the workflow guard, so the file has to exist.
  mkdirSync(join(dir, "agent", "lib"), { recursive: true });
  writeFileSync(workflowGuardPreload(dir), "export {};\n");
  const server = await startEveServer({
    agentDir: dir,
    base: {
      AI_GATEWAY_API_KEY: "gateway-key-0123456789",
      EVE_EVAL_AUTH_TOKEN: "client-token-0123456789",
      PATH: process.env.PATH ?? "",
    },
    discoveryFile: join(dir, "agent-server.json"),
    logFile: join(dir, "eve.log"),
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    root,
    startTimeoutMs: 20_000,
    withWorkflowGuard: true,
  });
  try {
    assert.match(server.url, pattern1);
    assert.equal(await healthOk(server.url), true);
    const seen = (await (await fetch(`${server.url}/env`)).json()) as {
      args: string[];
      cwd: string;
      env: Record<string, string | null>;
    };
    assert.deepEqual(seen.args, [...EVE_DEV_ARGS]);
    assert.match(seen.cwd, pattern2);
    assert.equal(seen.env.SAGE_DISCOVERY_FILE, join(dir, "agent-server.json"));
    assert.equal(seen.env.SAGE_TODAY, EVAL_TODAY);
    assert.match(seen.env.NODE_OPTIONS ?? "", pattern3);
    assert.equal(
      seen.env.EVE_EVAL_AUTH_TOKEN,
      null,
      "the server never holds the client's token"
    );
    assert.equal(
      seen.env.AI_GATEWAY_API_KEY,
      null,
      "the server never holds gateway keys"
    );
  } finally {
    await server.stop();
  }
  assert.equal(await healthOk(server.url), false);
});

test("startEveServer fails with the log when the server exits early", async (t) => {
  const dir = tempDir(t);
  fakeEve(
    dir,
    "console.error('cannot start: no such agent'); process.exit(1);"
  );
  await assert.rejects(
    startEveServer({
      agentDir: dir,
      base: { PATH: process.env.PATH ?? "" },
      logFile: join(dir, "eve.log"),
      ollamaBaseUrl: "http://127.0.0.1:11436/api",
      root: dir,
      startTimeoutMs: 10_000,
      withWorkflowGuard: false,
    }),
    pattern4
  );
});

test("healthOk is false when nothing answers", async () => {
  assert.equal(await healthOk("http://127.0.0.1:1"), false);
});
