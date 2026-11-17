// Environment for `make eval`.
//
// `loadEvalEnv` reads agent/.env, then agent/.env.local, and never replaces a
// value the shell already set. It replaces scripts/eval-env.sh.
//
// The runner starts Sage, `eve dev`, `ollama`, and `eve eval` with explicit
// environments built here. Gateway credentials reach only the `eve eval`
// client processes. Nothing else gets them, even when the shell or an env
// file holds them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type Env = Record<string, string | undefined>;

/**
 * Credentials for the cloud judge and simulated user. Client processes only.
 * These are the two the gateway SDK authenticates with. A base URL is not a
 * credential: the SDK never reads `AI_GATEWAY_BASE_URL`, so it must not satisfy
 * the key check.
 */
export const GATEWAY_ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
] as const;

// Names that look like credentials. A child process that does not need a
// credential never sees one.
const secretNamePattern =
  /^(?:AI_GATEWAY_|VERCEL_|BLOB_|EVE_EVAL_AUTH)|(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/iu;

export function isSecretName(name: string): boolean {
  return secretNamePattern.test(name);
}

/** True for the error `readFile` and friends throw when the file is not there. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** `dir` ahead of an existing PATH. */
export function prependPath(dir: string, existing: string | undefined): string {
  return existing === undefined || existing.length === 0
    ? dir
    : `${dir}:${existing}`;
}

/** Adds one option to a NODE_OPTIONS value, keeping what is there. */
export function addNodeOption(
  existing: string | undefined,
  option: string
): string {
  return existing === undefined || existing.length === 0
    ? option
    : `${existing} ${option}`;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** The variables in one env file. A missing file gives an empty object. */
export function readEnvFile(path: string): Record<string, string> {
  const text = readIfPresent(path);
  const found: Record<string, string> = {};
  if (text !== null) {
    for (const [name, value] of Object.entries(parseEnv(text))) {
      if (value !== undefined) {
        found[name] = value;
      }
    }
  }
  return found;
}

/** `.env`, then `.env.local`. A value in `.env.local` wins. */
export function loadEnvFiles(agentDir: string): Record<string, string> {
  return {
    ...readEnvFile(join(agentDir, ".env")),
    ...readEnvFile(join(agentDir, ".env.local")),
  };
}

/**
 * Puts the env files' variables into `env`. A variable already set there,
 * even to an empty string, keeps its value. With `only`, a variable is loaded
 * only when `only` accepts its name. Returns the names it added.
 */
export function loadEvalEnv(
  agentDir: string,
  env: Env = process.env,
  only?: (name: string) => boolean
): string[] {
  const added: string[] = [];
  for (const [name, value] of Object.entries(loadEnvFiles(agentDir))) {
    if (only !== undefined && !only(name)) {
      continue;
    }
    if (env[name] === undefined) {
      env[name] = value;
      added.push(name);
    }
  }
  return added.sort();
}

/** A copy of `env` without undefined values and without anything that looks like a credential. */
export function withoutSecrets(env: Env = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSecretName(name)) {
      clean[name] = value;
    }
  }
  return clean;
}

/**
 * Variables that only Sage reads. Every other process the runner starts goes
 * without them, even when the shell that started the runner set one.
 */
export const SAGE_ONLY_ENV = ["SAGE_EVAL_DREAM_PROMPTS"] as const;

/** `withoutSecrets`, and without the variables only Sage reads. */
export function withoutSageOnly(
  env: Env = process.env
): Record<string, string> {
  const clean = withoutSecrets(env);
  for (const name of SAGE_ONLY_ENV) {
    delete clean[name];
  }
  return clean;
}

/** Only the gateway credentials that are set in `env`. */
export function gatewayCredentials(
  env: Env = process.env
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of GATEWAY_ENV_KEYS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      found[name] = value;
    }
  }
  return found;
}

/**
 * The environment for the report upload: nothing that looks like a credential,
 * except the Blob token or store. The OIDC token goes along only when the store
 * id is the way in, because that is the one case where the upload reads it.
 */
export function uploadEnv(env: Env = process.env): Record<string, string> {
  const clean = withoutSecrets(env);
  const token = env.BLOB_READ_WRITE_TOKEN ?? "";
  const storeId = env.BLOB_STORE_ID ?? "";
  const oidc = env.VERCEL_OIDC_TOKEN ?? "";
  if (token.length > 0) {
    clean.BLOB_READ_WRITE_TOKEN = token;
  }
  if (storeId.length > 0) {
    clean.BLOB_STORE_ID = storeId;
  }
  if (token.length === 0 && storeId.length > 0 && oidc.length > 0) {
    clean.VERCEL_OIDC_TOKEN = oidc;
  }
  return clean;
}

/** Replaces each secret value in `text` with `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}
