import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentSource = readFileSync(
  join(repoRoot, "agent/agent/agent.ts"),
  "utf8"
);
const prefsSource = readFileSync(
  join(repoRoot, "frontend/src/lib/chat/model-prefs.ts"),
  "utf8"
);

// Not the agent's default. A hardcoded 32768 would still look like a fallback.
const fallbackContextWindow = 8192;

/**
 * Run the real `contextLengthFromContext` against one header value. The agent
 * module pulls in eve and the Ollama provider, so lift the function out of the
 * source and give it the two constants it closes over.
 */
function contextLengthFromHeader(
  header: string | undefined,
  contextWindow = fallbackContextWindow
): number {
  const declaration = agentSource.match(
    /(?:export )?function contextLengthFromContext\([\s\S]*?\n\}/
  );
  assert.ok(declaration, "contextLengthFromContext stays a top-level function");
  const cap = agentSource.match(/MAX_CONTEXT_LENGTH\s*=\s*([\d_]+)/);
  assert.ok(cap, "the agent names the picker maximum");
  const body = stripTypeScriptTypes(declaration[0], { mode: "strip" });
  const resolve = new Function(
    "contextWindow",
    "MAX_CONTEXT_LENGTH",
    `${body}\nreturn contextLengthFromContext;`
  )(contextWindow, Number(cap[1].replaceAll("_", ""))) as (ctx: unknown) => number;
  return resolve({
    session: {
      auth: {
        current: {
          attributes: header === undefined ? {} : { contextLength: header },
        },
      },
    },
  });
}

test("x-sage-context-length cannot raise num_ctx past the picker maximum", () => {
  assert.match(
    agentSource,
    /262_?144/,
    "desired: name the picker maximum, 262144 tokens. Today any finite positive number is passed through."
  );
  assert.match(
    agentSource,
    /Math\.min\(/,
    "desired: clamp the parsed header, so Number(\"1e12\") cannot allocate an unbounded num_ctx."
  );
  assert.equal(
    contextLengthFromHeader("1e12"),
    262144,
    "desired: a value far above the picker is capped."
  );
  assert.equal(contextLengthFromHeader("262145"), 262144);
  assert.equal(contextLengthFromHeader(String(Number.MAX_SAFE_INTEGER)), 262144);
});

test("a picked context length inside the picker range still passes through", () => {
  assert.equal(contextLengthFromHeader("98304"), 98304);
  assert.equal(contextLengthFromHeader("4096"), 4096);
  assert.equal(contextLengthFromHeader("12345.9"), 12345);
  assert.equal(contextLengthFromHeader("262144"), 262144);
});

test("a missing or invalid header still falls back to OLLAMA_CONTEXT_WINDOW", () => {
  assert.match(
    agentSource,
    /const contextWindow = Number\(process\.env\.OLLAMA_CONTEXT_WINDOW \?\? "32768"\)/,
    "the closed-over window is OLLAMA_CONTEXT_WINDOW, then 32768."
  );
  assert.equal(contextLengthFromHeader(undefined), fallbackContextWindow);
  assert.equal(contextLengthFromHeader(""), fallbackContextWindow);
  assert.equal(contextLengthFromHeader("abc"), fallbackContextWindow);
  assert.equal(contextLengthFromHeader("0"), fallbackContextWindow);
  assert.equal(contextLengthFromHeader("-1"), fallbackContextWindow);
  assert.equal(contextLengthFromHeader("Infinity"), fallbackContextWindow);
});

test("the agent cap and the Chat picker maximum are the same number", () => {
  const picked = [...prefsSource.matchAll(/\b(\d[\d_]*)/g)].map((match) =>
    Number(match[1].replaceAll("_", ""))
  );
  assert.equal(
    Math.max(...picked),
    262144,
    "frontend/src/lib/chat/model-prefs.ts still tops out at 262144 tokens."
  );
  assert.equal(contextLengthFromHeader("262144"), Math.max(...picked));
});
