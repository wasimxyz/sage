// The runner never edits agent/agent/, and shipped code never reads a prompt
// setting or an eval variable. Chat prompts are swapped by copying the app into
// agent/.eval-roots/<prompt>/ (see agent/scripts/eval/overlay.ts), and the
// cloud judge lives under agent/evals/. A packaged Chat must not be able to
// reach either.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentApp = join(repoRoot, "agent", "agent");

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

const forbidden: [string, RegExp][] = [
  ["an eval variable (SAGE_EVAL_)", /SAGE_EVAL_/u],
  ["the eval prompts folder (evals/prompts)", /evals\/prompts/u],
  ["the AI Gateway provider (@ai-sdk/gateway)", /@ai-sdk\/gateway/u],
  ["the AI Gateway client (createGateway)", /createGateway/u],
  ["an eval root (.eval-roots)", /\.eval-roots/u],
];

test("nothing under agent/agent/ mentions the eval suite or the cloud gateway", () => {
  const files = filesUnder(agentApp);
  assert.ok(files.length > 0, "agent/agent/ has files to check");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [what, pattern] of forbidden) {
      assert.ok(
        !pattern.test(text),
        `${relative(repoRoot, file)} mentions ${what}`
      );
    }
  }
});

test("the runner copies the app and swaps only instructions.md", () => {
  const overlay = readFileSync(
    join(repoRoot, "agent", "scripts", "eval", "overlay.ts"),
    "utf8"
  );
  assert.ok(overlay.includes('join(copy, "instructions.md")'));
  // Writes go under agent/.eval-roots/, never into agent/agent/.
  assert.ok(!overlay.includes('writeFileSync(join(agentDir, "agent"'));
});
