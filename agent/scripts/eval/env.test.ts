// Replaces scripts/eval-env.test.sh: the order `make eval` loads settings in.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addNodeOption,
  gatewayCredentials,
  isNotFound,
  isSecretName,
  loadEnvFiles,
  loadEvalEnv,
  prependPath,
  readEnvFile,
  redact,
  SAGE_ONLY_ENV,
  uploadEnv,
  withoutSageOnly,
  withoutSecrets,
} from "./env.ts";

function tempAgentDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-env-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test(".env.local wins over .env, and .env fills what .env.local lacks", (t) => {
  const dir = tempAgentDir(t);
  writeFileSync(
    join(dir, ".env"),
    "SAGE_CHAT_MODELS=from-env\nSAGE_JUDGE_MODEL=from-env\nSAGE_EMBED_MODELS=from-env\n"
  );
  writeFileSync(
    join(dir, ".env.local"),
    "SAGE_CHAT_MODELS=from-local\nSAGE_SUMMARY_MODELS=from-local\n"
  );
  const env: Record<string, string | undefined> = {};
  const added = loadEvalEnv(dir, env);
  assert.equal(env.SAGE_CHAT_MODELS, "from-local");
  assert.equal(env.SAGE_JUDGE_MODEL, "from-env");
  assert.equal(env.SAGE_SUMMARY_MODELS, "from-local");
  assert.equal(env.SAGE_EMBED_MODELS, "from-env");
  assert.deepEqual(added, [
    "SAGE_CHAT_MODELS",
    "SAGE_EMBED_MODELS",
    "SAGE_JUDGE_MODEL",
    "SAGE_SUMMARY_MODELS",
  ]);
});

test("a value the shell already set keeps its value, even an empty one", (t) => {
  const dir = tempAgentDir(t);
  writeFileSync(
    join(dir, ".env"),
    "SAGE_CHAT_MODELS=from-env\nOLLAMA_BASE_URL=http://x\n"
  );
  const env: Record<string, string | undefined> = {
    OLLAMA_BASE_URL: "",
    SAGE_CHAT_MODELS: "from-shell",
  };
  loadEvalEnv(dir, env);
  assert.equal(env.SAGE_CHAT_MODELS, "from-shell");
  assert.equal(env.OLLAMA_BASE_URL, "");
});

test("a folder with no env files loads nothing", (t) => {
  const dir = tempAgentDir(t);
  const env: Record<string, string | undefined> = {};
  assert.deepEqual(loadEvalEnv(dir, env), []);
  assert.deepEqual(env, {});
  assert.deepEqual(readEnvFile(join(dir, ".env")), {});
});

test("env files can quote values, comment, and export", (t) => {
  const dir = tempAgentDir(t);
  writeFileSync(
    join(dir, ".env.local"),
    ["# a comment", "export A=1", 'B="two words"', "C='single'", "D=", ""].join(
      "\n"
    )
  );
  assert.deepEqual(loadEnvFiles(dir), {
    A: "1",
    B: "two words",
    C: "single",
    D: "",
  });
});

test("withoutSecrets drops credentials and undefined values", () => {
  const clean = withoutSecrets({
    AI_GATEWAY_API_KEY: "k",
    BLOB_READ_WRITE_TOKEN: "t",
    EVE_EVAL_AUTH_TOKEN: "t",
    GITHUB_TOKEN: "t",
    HOME: "/home/x",
    MISSING: undefined,
    PATH: "/bin",
    SAGE_SUMMARY_MODEL: "qwen3.5:9b",
    VERCEL_OIDC_TOKEN: "t",
  });
  assert.deepEqual(clean, {
    HOME: "/home/x",
    PATH: "/bin",
    SAGE_SUMMARY_MODEL: "qwen3.5:9b",
  });
  assert.ok(isSecretName("AI_GATEWAY_API_KEY"));
  assert.ok(!isSecretName("SAGE_EVAL_RUN_DIR"));
});

test("gatewayCredentials returns only the gateway keys that are set", () => {
  assert.deepEqual(
    gatewayCredentials({
      AI_GATEWAY_API_KEY: "key",
      BLOB_READ_WRITE_TOKEN: "blob",
      VERCEL_OIDC_TOKEN: "",
    }),
    { AI_GATEWAY_API_KEY: "key" }
  );
});

test("a gateway base URL alone is not a credential", () => {
  // The gateway SDK authenticates with the API key or the OIDC token only. A
  // run with just a base URL would start, and every judge call would fail.
  assert.deepEqual(
    gatewayCredentials({
      AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v4/ai",
    }),
    {}
  );
  assert.deepEqual(
    gatewayCredentials({
      AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v4/ai",
      VERCEL_OIDC_TOKEN: "oidc",
    }),
    { VERCEL_OIDC_TOKEN: "oidc" }
  );
});

test("uploadEnv gives the upload the Blob variables and no gateway key", () => {
  const base = {
    AI_GATEWAY_API_KEY: "gateway-key",
    BLOB_READ_WRITE_TOKEN: "blob-token",
    HOME: "/home/x",
    PATH: "/bin",
    SAGE_EVAL_BLOB_ACCESS: "public",
    VERCEL_OIDC_TOKEN: "oidc",
  };
  assert.deepEqual(uploadEnv(base), {
    BLOB_READ_WRITE_TOKEN: "blob-token",
    HOME: "/home/x",
    PATH: "/bin",
    SAGE_EVAL_BLOB_ACCESS: "public",
  });
  // A connected store signs in with the OIDC token, so that one goes along.
  const { BLOB_READ_WRITE_TOKEN: _token, ...store } = base;
  assert.deepEqual(uploadEnv({ ...store, BLOB_STORE_ID: "store_1" }), {
    BLOB_STORE_ID: "store_1",
    HOME: "/home/x",
    PATH: "/bin",
    SAGE_EVAL_BLOB_ACCESS: "public",
    VERCEL_OIDC_TOKEN: "oidc",
  });
  assert.equal(uploadEnv(store).VERCEL_OIDC_TOKEN, undefined);
});

test("the variables only Sage reads are kept out of every other process", () => {
  assert.deepEqual([...SAGE_ONLY_ENV], ["SAGE_EVAL_DREAM_PROMPTS"]);
  const base = {
    AI_GATEWAY_API_KEY: "secret",
    HOME: "/home/x",
    SAGE_EVAL_DREAM_PROMPTS: "/repo/agent/evals/dream-prompts/careful",
    SAGE_EVAL_PERSON: "sam",
  };
  assert.deepEqual(withoutSageOnly(base), {
    HOME: "/home/x",
    SAGE_EVAL_PERSON: "sam",
  });
});

test("redact hides long secrets and leaves short ones", () => {
  assert.equal(
    redact("a secret-value-123 here", ["secret-value-123"]),
    "a [redacted] here"
  );
  assert.equal(redact("abc", ["abc"]), "abc");
});

test("prependPath and addNodeOption keep what is there", () => {
  assert.equal(prependPath("/a", undefined), "/a");
  assert.equal(prependPath("/a", ""), "/a");
  assert.equal(prependPath("/a", "/b:/c"), "/a:/b:/c");
  assert.equal(addNodeOption(undefined, "--x"), "--x");
  assert.equal(
    addNodeOption("--max-old-space-size=4096", "--x"),
    "--max-old-space-size=4096 --x"
  );
});

test("isNotFound is true for a missing file only", (t) => {
  const dir = tempAgentDir(t);
  assert.throws(
    () => readEnvFile(dir),
    (error: unknown) => !isNotFound(error)
  );
  try {
    writeFileSync(join(dir, "no-such-dir", "x"), "");
    assert.fail("write should have failed");
  } catch (error) {
    assert.ok(isNotFound(error));
  }
  assert.ok(!isNotFound(new Error("other")));
  assert.ok(!isNotFound(null));
});

test("a filter keeps names it does not accept out of the environment", (t) => {
  const dir = tempAgentDir(t);
  writeFileSync(
    join(dir, ".env.local"),
    "AI_GATEWAY_API_KEY=secret\nBLOB_READ_WRITE_TOKEN=blob\n"
  );
  const env: Record<string, string | undefined> = {};
  const added = loadEvalEnv(dir, env, (name) => name.startsWith("BLOB_"));
  assert.deepEqual(added, ["BLOB_READ_WRITE_TOKEN"]);
  assert.equal(env.AI_GATEWAY_API_KEY, undefined);
  assert.equal(env.BLOB_READ_WRITE_TOKEN, "blob");
});
