import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("cancelSession must send the agent-server token", () => {
  const sidecar = readFileSync(join(repoRoot, "src/eve_sidecar.zig"), "utf8");
  const main = readFileSync(join(repoRoot, "src/main.zig"), "utf8");
  assert.match(
    sidecar,
    /Authorization: Bearer \{s\}/,
    "desired: cancelSession sends Authorization: Bearer with the agent-server token. Today the cancel request has no secret."
  );
  assert.match(
    sidecar,
    /pub fn cancelSession\([\s\S]*token: \[\]const u8/,
    "desired: cancelSession takes the token it puts on the request."
  );
  assert.match(
    main,
    /if \(self\.eve\.agent_token_hex\) \|token\| \{\s*eve_sidecar\.cancelSession\(self\.io, session_id, token\);/,
    "desired: chat delete passes the same token Sage handed the agent."
  );
});
