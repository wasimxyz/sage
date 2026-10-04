import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("packaged Chat must not copy the whole parent environment into eve start", () => {
  const sidecar = readFileSync(join(repoRoot, "src/eve_sidecar.zig"), "utf8");
  assert.doesNotMatch(
    sidecar,
    /for \(keys, values\) \|key, value\|/,
    "desired: copy an allowlist into the Chat agent. Today eve_sidecar copies every parent environment variable."
  );
});

test("packaged Chat must pin Ollama to 127.0.0.1, not inherit OLLAMA_BASE_URL", () => {
  const sidecar = readFileSync(join(repoRoot, "src/eve_sidecar.zig"), "utf8");
  const agent = readFileSync(join(repoRoot, "agent/agent/agent.ts"), "utf8");
  assert.match(agent, /OLLAMA_BASE_URL/);
  assert.match(
    sidecar,
    /child_env\.put\("OLLAMA_BASE_URL", "http:\/\/127\.0\.0\.1:11434/,
    "desired: eve start always calls local Ollama. Today a parent OLLAMA_BASE_URL is inherited and Chat will send prompts there."
  );
});
