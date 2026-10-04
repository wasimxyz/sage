import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const hostSource = read("frontend/src/lib/chat/eve-host.ts");
const providerSource = read("frontend/src/components/chat-provider.tsx");

const portBusyMessage = "Port 2001 is already in use, so Chat cannot start.";

interface DecisionInput {
  downMessage: string;
  graceMs?: number;
  healthOk: boolean;
  nowMs: number;
  sidecar: string | null;
  startedAtMs: number;
}

type Decision = { kind: "checking" | "down" | "ready"; message?: string };

/**
 * Slice one `function name(...) { ... }` out of a source file by matching
 * braces, so moving or adding neighbouring exports does not break the lift.
 * The body brace is the first `{` outside the parameter list, which keeps an
 * inline parameter type like `input: { healthOk: boolean }` from being read as
 * the body.
 */
function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} stays a top-level function`);
  let bodyStart = start;
  let parens = 0;
  while (bodyStart < source.length) {
    const char = source[bodyStart];
    if (char === "(") {
      parens += 1;
    } else if (char === ")") {
      parens -= 1;
    } else if (char === "{" && parens === 0) {
      break;
    }
    bodyStart += 1;
  }
  assert.ok(bodyStart < source.length, `${name} has a body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${name} has no closing brace`);
}

/**
 * Run the real `agentHealthDecision` against one poll. The module reads
 * `import.meta.env` in the paths that build a host, so lift the function out of
 * the source and give it the startup grace it closes over.
 */
function decide(input: DecisionInput): Decision {
  const declaration = sliceFunction(hostSource, "agentHealthDecision");
  const grace = hostSource.match(/eveStartupGraceMs\s*=\s*([\d_]+)/);
  assert.ok(grace, "the host names the startup grace");
  const body = stripTypeScriptTypes(declaration, { mode: "strip" });
  const resolve = new Function(
    "eveStartupGraceMs",
    `${body}\nreturn agentHealthDecision;`
  )(Number(grace[1].replaceAll("_", ""))) as (value: DecisionInput) => Decision;
  return resolve(input);
}

test("a healthy answer is not enough while Sage's sidecar is not ready", () => {
  for (const sidecar of ["down", "missing_build", "missing_node", "port_busy"]) {
    assert.deepEqual(
      decide({
        downMessage: portBusyMessage,
        healthOk: true,
        nowMs: 0,
        sidecar,
        startedAtMs: 0,
      }),
      { kind: "down", message: portBusyMessage },
      `desired: a status of ${sidecar} keeps Chat down, because another program bound to 2001 answers health. Today any { "ok": true } wins.`
    );
  }
});

test("a busy port keeps its own message while a stand-in answers health", () => {
  const decision = decide({
    downMessage: portBusyMessage,
    healthOk: true,
    nowMs: 30_000,
    sidecar: "port_busy",
    startedAtMs: 0,
  });
  assert.deepEqual(decision, {
    kind: "down",
    message: portBusyMessage,
  });
});

test("a ready sidecar with a healthy port is still ready", () => {
  assert.deepEqual(
    decide({
      downMessage: portBusyMessage,
      healthOk: true,
      nowMs: 0,
      sidecar: "ready",
      startedAtMs: 0,
    }),
    { kind: "ready" }
  );
});

test("a ready sidecar starts checking while its server is still coming up", () => {
  assert.deepEqual(
    decide({
      downMessage: portBusyMessage,
      healthOk: false,
      nowMs: 1000,
      sidecar: "ready",
      startedAtMs: 0,
    }),
    { kind: "checking" }
  );
});

test("make dev keeps deciding on health, where Sage owns no port", () => {
  assert.deepEqual(
    decide({
      downMessage: "The Chat agent isn't running.",
      healthOk: true,
      nowMs: 0,
      sidecar: null,
      startedAtMs: 0,
    }),
    { kind: "ready" }
  );
  assert.deepEqual(
    decide({
      downMessage: "The Chat agent isn't running.",
      healthOk: false,
      nowMs: 100,
      sidecar: null,
      startedAtMs: 0,
    }),
    { kind: "down", message: "The Chat agent isn't running." }
  );
});

// The lift above proves the rule. These patterns prove the screen feeds the
// rule a status, and they key on identifiers rather than exact statements, so a
// reformat or a rename does not break them.
test("the Chat screen asks chat.agent on every packaged poll", () => {
  assert.doesNotMatch(
    providerSource,
    /healthOk\s*(?:\|\||&&|\?)|\bif\s*\(\s*!?\s*healthOk/,
    "desired: health must not decide whether chat.agent is read. Gating that read is what let a stand-in win."
  );
  assert.match(
    providerSource,
    /await\s+getChatAgent\(\)/,
    "desired: read the status the packaged app reports for the sidecar it started."
  );
  assert.match(
    providerSource,
    /sidecar:\s*status\.status/,
    "desired: carry that status out of the packaged startup read."
  );
  assert.match(
    providerSource,
    /sidecar:\s*[A-Za-z_$][\w$]*\.sidecar/,
    "desired: hand a real status to agentHealthDecision, so health alone cannot make Chat ready."
  );
  assert.match(
    providerSource,
    /sidecar:\s*null/,
    "desired: make dev passes no status; the agent starts on its own there and health decides."
  );
});
