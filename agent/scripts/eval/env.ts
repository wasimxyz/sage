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

/** Credentials for the cloud judge and simulated user. Client processes only. */
export const GATEWAY_ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "VERCEL_OIDC_TOKEN",
] as const;

// Names that look like credentials. A child process that does not need a
// credential never sees one.
const secretNamePattern =
  /^(?:AI_GATEWAY_|VERCEL_|BLOB_|EVE_EVAL_AUTH)|(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/iu;

export function isSecretName(name: string): boolean {
  return secretNamePattern.test(name);
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

/** The variables in one env file. A missing file gives an empty object. */
export function readEnvFile(path: string): Record<string, string> {
  const text = readIfPresent(path);
  return text === null ? {} : { ...parseEnv(text) };
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
 * even to an empty string, keeps its value. Returns the names it added.
 */
export function loadEvalEnv(agentDir: string, env: Env = process.env): string[] {
  const added: string[] = [];
  for (const [name, value] of Object.entries(loadEnvFiles(agentDir))) {
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

/** Only the gateway credentials that are set in `env`. */
export function gatewayCredentials(env: Env = process.env): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of GATEWAY_ENV_KEYS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      found[name] = value;
    }
  }
  return found;
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
