import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the Chat agent must pin Ollama to 127.0.0.1, not inherit a remote URL", () => {
  const sidecar = readFileSync(join(repoRoot, "src/eve_sidecar.zig"), "utf8");
  const agent = readFileSync(join(repoRoot, "agent/agent/agent.ts"), "utf8");
  const ollama = readFileSync(join(repoRoot, "src/ollama.zig"), "utf8");

  assert.match(ollama, /pub const host = "127\.0\.0\.1"/);
  assert.match(agent, /OLLAMA_BASE_URL/);
  assert.doesNotMatch(
    agent,
    /OLLAMA_API_KEY/,
    "agent.ts reads an Ollama API key, which only a remote server needs."
  );
  assert.match(
    agent,
    /localOllamaBaseURL\(/,
    "agent.ts does not require a loopback OLLAMA_BASE_URL."
  );
  assert.match(
    agent,
    /assertLocalModel\(/,
    "agent.ts does not check each chat model against /api/tags, so a cloud model named in x-sage-model would receive the prompt."
  );
  assert.match(
    sidecar,
    /"http:\/\/\{s\}:\{d\}\/api", \.\{ ollama\.host, ollama\.port \}/,
    "eve_sidecar does not build OLLAMA_BASE_URL from the loopback host and the runtime port, so Chat can be pointed at a remote host."
  );
  assert.match(
    sidecar,
    /child_env\.put\("OLLAMA_BASE_URL", ollama_base\)/,
    "eve_sidecar copies the whole process environment into the Chat agent. OLLAMA_BASE_URL is not pinned to the local URL, so Chat can send journal text to a remote host."
  );
});

// The server's environment is built by `fillServeEnv`, and `attempt` spawns the
// child with exactly that map. Slice the builder so the checks read its body and
// nothing else. A missing marker would widen the slice silently, so each one is
// checked first.
test("the bundled Ollama server gets loopback, no cloud, no prune, and no other OLLAMA_* setting", () => {
  const server = readFileSync(join(repoRoot, "src/ollama_server.zig"), "utf8");
  const start = server.indexOf("pub fn fillServeEnv(");
  const end = server.indexOf("\n}\n", start);
  assert.ok(
    start >= 0 && end > start,
    "could not slice `fillServeEnv`: an index marker is missing or moved, so this check is reading the wrong region."
  );
  const fill = server.slice(start, end);

  assert.match(
    fill,
    /child_env\.put\("OLLAMA_HOST", host_value\)/,
    "fillServeEnv does not set OLLAMA_HOST from the server port, so the server can bind to any interface."
  );
  assert.match(
    fill,
    /ollama\.host/,
    "fillServeEnv does not take the server host from the loopback constant in ollama.zig."
  );
  assert.match(
    fill,
    /"OLLAMA_NO_CLOUD", "1"/,
    "fillServeEnv does not turn cloud models off for the server."
  );
  assert.match(
    fill,
    /"OLLAMA_NOPRUNE", "1"/,
    "fillServeEnv does not turn off blob pruning, so a shared model folder can lose blobs another app still uses."
  );
  assert.match(
    fill,
    /parent\.get\("OLLAMA_MODELS"\)/,
    "fillServeEnv does not pass OLLAMA_MODELS through, so a user's model folder is ignored."
  );
  assert.match(
    fill,
    /eve_sidecar\.chat_env_allowlist/,
    "fillServeEnv does not start from the shared allowlist, so the whole parent environment may reach the server."
  );

  // Every OLLAMA_* name the builder writes or reads, and nothing else.
  const names = new Set(fill.match(/"OLLAMA_[A-Z_]+"/g) ?? []);
  assert.deepEqual(
    [...names].sort(),
    ['"OLLAMA_HOST"', '"OLLAMA_MODELS"', '"OLLAMA_NOPRUNE"', '"OLLAMA_NO_CLOUD"'],
    "fillServeEnv names an OLLAMA_* variable outside the four it may pass to the server."
  );

  assert.match(
    server,
    /fillServeEnv\(&env, self\.env_map\.\?, self\.port\)/,
    "the server child is not started with the map from fillServeEnv."
  );
  assert.match(
    server,
    /\.environ_map = &env/,
    "the server child inherits the parent environment instead of the map from fillServeEnv."
  );
});
