// `make eval` must hand `eve eval` a URL target and Sage's agent-server token.
// eve applies EVE_EVAL_AUTH_TOKEN only to a URL target; for a local target it
// starts its own server and sends no token, and the channel answers 401. The
// runner therefore starts headless servers itself, on loopback and a free
// port, and reads the token from the throwaway agent-server.json. This ports
// the checks scripts/eval-run.sh used to get from grepping its own text.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CliError,
  parseCli,
  URL_MESSAGE,
} from "../agent/scripts/eval/cli.ts";
import {
  EVE_DEV_ARGS,
  eveDevEnv,
  healthOk,
  parseListeningPort,
  readServerToken,
} from "../agent/scripts/eval/eve.ts";
import {
  buildPassEnv,
  evalRunArgs,
} from "../agent/scripts/eval/passes.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "agent");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");

const token = "tok-0123456789abcdef-not-a-real-token";

function passEnvInput(withToken: boolean) {
  return {
    agentDir,
    credentials: { AI_GATEWAY_API_KEY: "gateway-key-0123456789" },
    dataDir: "/tmp/sage-eval-x",
    dataRoot: "/tmp/data",
    discoveryFile: "/tmp/sage-eval-x/agent-server.json",
    manifest: "/tmp/sage-eval-x/manifest.json",
    models: { chat: "qwen3.5:9b", embed: "nomic-embed-text", summary: "qwen3.5:9b" },
    person: "sam-example",
    repoRoot,
    results: "/tmp/r.jsonl",
    runDir: "/tmp/run",
    setupId: "0123456789",
    sweepFile: "/tmp/run/sweep.json",
    sweepId: "2026-11-10T031500Z-smoke",
    token: withToken ? token : undefined,
    transcripts: "/tmp/t.jsonl",
    base: { PATH: "/usr/bin" },
  };
}

test("ARGS cannot replace the target URL", () => {
  for (const argv of [
    ["--url", "https://example.invalid"],
    ["--url=https://example.invalid"],
    ["--sweep", "smoke", "--url", "https://example.invalid"],
  ]) {
    assert.throws(
      () => parseCli(argv),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 2 &&
        error.message.includes("make eval controls the target URL")
    );
  }
  assert.equal(URL_MESSAGE, "make eval controls the target URL; do not pass --url in ARGS.");
});

test("the runner exits with 2 and the same message when ARGS carries --url", () => {
  const entry = join(agentDir, "scripts", "eval", "run.ts");
  for (const flag of [["--url", "https://example.invalid"], ["--url=https://example.invalid"]]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", entry, ...flag],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(result.status, 2, `exit status for ${flag.join(" ")}`);
    assert.ok(
      result.stderr.includes("make eval controls the target URL"),
      "the runner explains that it owns --url"
    );
  }
});

test("every pass runs eve eval against a URL", () => {
  const args = evalRunArgs({
    agentDir,
    concurrency: 1,
    filters: ["--tag", "example"],
    prefixes: ["chat/facts"],
    url: "http://127.0.0.1:1234",
  });
  const at = args.indexOf("--url");
  assert.ok(at > 0 && args[at + 1] === "http://127.0.0.1:1234");
  assert.equal(args[0], "eval");
  // Nothing outside passes.ts builds an `eve eval` command.
  const sources = ["unit.ts", "runner.ts", "dream.ts", "sage.ts"].map((file) =>
    read(`agent/scripts/eval/${file}`)
  );
  for (const source of sources) {
    assert.ok(
      !source.includes('"eval"'),
      "only passes.ts builds an eve eval command line"
    );
  }
});

test("the eval agent server is headless, on loopback, and on a free port", () => {
  const args = [...EVE_DEV_ARGS];
  assert.deepEqual(args.slice(0, 2), ["dev", "--no-ui"]);
  assert.ok(args.includes("--no-default-extensions"));
  const host = args.indexOf("--host");
  assert.equal(args[host + 1], "127.0.0.1");
  const port = args.indexOf("--port");
  assert.equal(args[port + 1], "0");
});

test("the server reads the token from the throwaway discovery file", () => {
  const env = eveDevEnv({
    agentDir,
    base: { PATH: "/usr/bin" },
    discoveryFile: "/tmp/sage-eval-x/agent-server.json",
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    withWorkflowGuard: true,
  });
  assert.equal(env.SAGE_DISCOVERY_FILE, "/tmp/sage-eval-x/agent-server.json");
});

test("the token reaches the client, not the server", () => {
  const server = eveDevEnv({
    agentDir,
    base: {
      EVE_EVAL_AUTH_TOKEN: token,
      PATH: "/usr/bin",
    },
    discoveryFile: "/tmp/sage-eval-x/agent-server.json",
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    withWorkflowGuard: true,
  });
  assert.equal(server.EVE_EVAL_AUTH_TOKEN, undefined);
  assert.ok(!JSON.stringify(server).includes(token));

  const client = buildPassEnv(passEnvInput(true));
  assert.equal(client.EVE_EVAL_AUTH_TOKEN, token);
  const noToken = buildPassEnv(passEnvInput(false));
  assert.equal(noToken.EVE_EVAL_AUTH_TOKEN, undefined);
});

test("the token comes from the discovery file and is never printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-token-"));
  const file = join(dir, "agent-server.json");
  writeFileSync(file, JSON.stringify({ socket: "/tmp/x.sock", token }));
  assert.equal(readServerToken(file), token);
  assert.throws(() => readServerToken(join(dir, "missing.json")), /agent-server token/u);
  writeFileSync(file, JSON.stringify({ socket: "/tmp/x.sock", token: "" }));
  assert.throws(() => readServerToken(file), /no agent-server token/u);

  // Only passes.ts sets the client's variable, and nothing takes it from the shell.
  for (const file of ["eve.ts", "unit.ts", "runner.ts", "sage.ts", "dream.ts"]) {
    const source = read(`agent/scripts/eval/${file}`);
    assert.ok(
      !source.includes("process.env.EVE_EVAL_AUTH_TOKEN"),
      `${file} must not read the eval token from the shell`
    );
    for (const line of source.split("\n")) {
      assert.ok(
        !(/console\./u.test(line) && /token/iu.test(line)),
        `${file} must not print the token: ${line.trim()}`
      );
    }
  }
});

test("the health probe sends no Authorization header", async () => {
  const probe = healthOk.toString();
  assert.ok(!/authorization/iu.test(probe), "health is public; probing it with a token would pass against a server that rejects every token");
  assert.ok(probe.includes("/eve/v1/health"));
});

test("eve's listening line gives the port", () => {
  assert.equal(
    parseListeningPort("☰eve v0.80.1\n[DEV] server listening at http://127.0.0.1:54739/\n"),
    54_739
  );
  assert.equal(parseListeningPort("starting..."), null);
});

test("every server the runner starts is stopped with SIGTERM and then waited for", () => {
  const proc = read("agent/scripts/eval/proc.ts");
  assert.ok(proc.includes('"SIGTERM"'));
  assert.ok(proc.includes("hasExited"));
  const eve = read("agent/scripts/eval/eve.ts");
  assert.ok(eve.includes("stopProcess(child"));
});
