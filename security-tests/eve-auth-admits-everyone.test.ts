import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Chat must require the agent-server token on eve routes", () => {
  const channel = readFileSync(
    join(repoRoot, "agent/agent/channels/eve.ts"),
    "utf8"
  );
  assert.match(
    channel,
    /headers\.get\("authorization"\)/,
    "desired: read the Authorization header. Today sageDesktop admits every caller."
  );
  assert.match(
    channel,
    /expectedChatToken/,
    "desired: compare the bearer token with Sage's agent-server token."
  );
  assert.match(
    channel,
    /!bearerMatches\(expected, presented\)/,
    "desired: compare the token with the shared constant-time check."
  );
  const bearer = readFileSync(
    join(repoRoot, "agent/agent/lib/bearer.ts"),
    "utf8"
  );
  assert.match(
    bearer,
    /timingSafeEqual/,
    "desired: compare the token in constant time."
  );
  assert.match(
    channel,
    /return null;/,
    "desired: a missing or wrong token returns null so eve answers 401."
  );
  assert.match(
    channel,
    /allowedHeaders:\s*"\*"/,
    "desired: CORS echoes request headers so Authorization reaches packaged Chat."
  );
});

test("eve health route stays public", () => {
  const compiled = readFileSync(
    join(
      repoRoot,
      "agent/node_modules/eve/dist/src/eve-channel/index.js"
    ),
    "utf8"
  );
  assert.match(
    compiled,
    /GET\(EVE_HEALTH_ROUTE_PATH,async\(\)=>healthResponse\(\)\)/,
    "GET /eve/v1/health stays public. It reports only that the agent is up."
  );
});

test("the workflow routes need the agent-server token in every launch path", () => {
  const preload = "agent/lib/workflow-guard-preload.ts";
  const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
  assert.match(
    read("agent/agent/lib/workflow-guard-preload.ts"),
    /installWorkflowGuard\(\)/,
    "desired: the preload installs the guard. eve mounts /.well-known/workflow/ with no auth of its own."
  );
  assert.match(
    read("agent/package.json"),
    /--import=[\\"]+\$\(pwd\)\/agent\/lib\/workflow-guard-preload\.ts/,
    "desired: `eve dev` loads the guard, so the dev port is locked too."
  );
  assert.ok(
    read("scripts/eval-run.sh").includes(`--import=\\"$agent/${preload}\\"`),
    "desired: the eval agent server loads the guard."
  );
  const sidecar = read("src/eve_sidecar.zig");
  assert.match(
    sidecar,
    /"--import",\s*guard_preload,\s*server_entry/,
    "desired: packaged Chat starts Node with the guard ahead of the server."
  );
});

test("the workflow guard covers every way Node hands a request to the server", () => {
  const guard = readFileSync(
    join(repoRoot, "agent/agent/lib/workflow-guard.ts"),
    "utf8"
  );
  for (const event of ["request", "checkContinue", "checkExpectation", "upgrade", "connect"]) {
    assert.ok(
      guard.includes(`"${event}"`),
      `desired: the guard checks the ${event} event. A request that skips it reaches the workflow routes with no token.`
    );
  }
});
