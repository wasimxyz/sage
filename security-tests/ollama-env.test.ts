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
    /child_env\.put\("OLLAMA_BASE_URL", "http:\/\/127\.0\.0\.1:11434/,
    "eve_sidecar copies the whole process environment into the Chat agent. OLLAMA_BASE_URL is not pinned to 127.0.0.1, so Chat can send journal text to a remote host."
  );

  // Slice the function that starts `ollama serve`, so the two checks below
  // read its argv and nothing else. A missing or reordered marker used to
  // widen the slice silently — with no `fn waitUntilRunning` the range ran to
  // the end of the file and the checks passed on strings outside it.
  const serveStart = ollama.indexOf("fn launchServe");
  const serveEnd = ollama.indexOf("fn waitUntilRunning");
  assert.ok(
    serveStart >= 0 && serveEnd > serveStart,
    "could not slice `launchServe`: an index marker is missing or moved, so this check is reading the wrong region."
  );
  const serve = ollama.slice(serveStart, serveEnd);
  assert.match(serve, /macos_env_path/);
  assert.match(
    serve,
    /OLLAMA_HOST=\{s\}:\{d\}/,
    "launchServe starts `ollama serve` with the inherited environment. Unless OLLAMA_HOST is pinned, a parent value can bind the server to another port or expose it off the loopback interface."
  );
});
