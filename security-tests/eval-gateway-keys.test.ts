// The cloud judge and the simulated user need AI Gateway credentials. They go
// to the `eve eval` client processes and nowhere else: not to Sage, not to
// `eve dev`, not to Ollama, and not to the seed script. The journal stays on
// this Mac, and the only thing that leaves it is the made-up cases under
// agent/evals/data/, sent by the judge.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { seedEnv } from "../agent/scripts/eval/dream.ts";
import {
  GATEWAY_ENV_KEYS,
  gatewayCredentials,
  isSecretName,
  redact,
  withoutSecrets,
} from "../agent/scripts/eval/env.ts";
import { eveDevEnv } from "../agent/scripts/eval/eve.ts";
import { buildPassEnv } from "../agent/scripts/eval/passes.ts";
import { sageEnv } from "../agent/scripts/eval/sage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "agent");

const shell = {
  AI_GATEWAY_API_KEY: "gw-key-0123456789abcdef",
  BLOB_READ_WRITE_TOKEN: "blob-token-0123456789",
  EVE_EVAL_AUTH_TOKEN: "eve-token-0123456789",
  HOME: "/Users/someone",
  PATH: "/usr/bin",
  VERCEL_OIDC_TOKEN: "oidc-token-0123456789",
};

/** The shell's credential values that appear anywhere in an environment. */
function holdsSecret(env: Record<string, string | undefined>): string[] {
  const text = JSON.stringify(env);
  return Object.entries(shell)
    .filter(([name, value]) => isSecretName(name) && text.includes(value))
    .map(([name]) => name);
}

test("Sage gets no credentials", () => {
  const env = sageEnv({
    base: shell,
    dataDir: "/tmp/sage-eval-x",
    embedModel: "nomic-embed-text",
    ollamaBin: "/opt/ollama",
    summaryModel: "qwen3.5:9b",
  });
  assert.deepEqual(holdsSecret(env), []);
  assert.equal(env.HOME, "/Users/someone");
});

test("eve dev gets no credentials", () => {
  const env = eveDevEnv({
    agentDir,
    base: shell,
    discoveryFile: "/tmp/sage-eval-x/agent-server.json",
    ollamaBaseUrl: "http://127.0.0.1:11436/api",
    withWorkflowGuard: true,
  });
  assert.deepEqual(holdsSecret(env), []);
});

test("the seed script gets no credentials", () => {
  const previous = { ...process.env };
  Object.assign(process.env, shell);
  try {
    const env = seedEnv({
      automationCwd: "/tmp/sage-eval-x",
      dataDir: "/tmp/sage-eval-x",
      manifestPath: "/tmp/sage-eval-x/manifest.json",
      personId: "sam-example",
    });
    assert.deepEqual(holdsSecret(env), []);
  } finally {
    for (const name of Object.keys(shell)) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
});

test("only the eve eval clients get the gateway credentials", () => {
  const credentials = gatewayCredentials(shell);
  assert.deepEqual(Object.keys(credentials).sort(), [
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
  ]);
  const client = buildPassEnv({
    agentDir,
    base: shell,
    credentials,
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
    transcripts: "/tmp/t.jsonl",
  });
  assert.equal(client.AI_GATEWAY_API_KEY, shell.AI_GATEWAY_API_KEY);
  assert.equal(client.VERCEL_OIDC_TOKEN, shell.VERCEL_OIDC_TOKEN);
  // Nothing else that looks like a credential comes along from the shell.
  assert.equal(client.BLOB_READ_WRITE_TOKEN, undefined);
  assert.equal(client.EVE_EVAL_AUTH_TOKEN, undefined);
});

test("names that look like credentials are dropped, and the gateway keys are among them", () => {
  for (const name of GATEWAY_ENV_KEYS) {
    assert.ok(isSecretName(name), `${name} counts as a credential`);
  }
  for (const name of ["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "DB_PASSWORD"]) {
    assert.ok(isSecretName(name), name);
  }
  for (const name of ["PATH", "HOME", "SAGE_DATA_DIR", "TMPDIR", "NODE_OPTIONS"]) {
    assert.ok(!isSecretName(name), name);
  }
  assert.deepEqual(withoutSecrets({ A: "1", AI_GATEWAY_API_KEY: "x", B: undefined }), {
    A: "1",
  });
});

test("redact replaces a secret wherever it appears", () => {
  assert.equal(
    redact("bearer eve-token-0123456789 then eve-token-0123456789", ["eve-token-0123456789"]),
    "bearer [redacted] then [redacted]"
  );
  assert.equal(redact("short", ["abc"]), "short");
});
