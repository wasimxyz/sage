import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("copy-agent targets Sage.app, not the newest sibling bundle", () => {
  const script = readFileSync(
    join(repoRoot, "scripts/copy-agent-into-app.sh"),
    "utf8"
  );
  assert.doesNotMatch(
    script,
    /ls -td/,
    "desired: do not pick zig-out/package/*.app by mtime. That copied the agent into a sibling bundle and left Sage.app on an old CORS list."
  );
  assert.match(
    script,
    /zig-out\/package\/Sage\.app/,
    "desired: with no argument, copy into the native package Sage.app."
  );
});
