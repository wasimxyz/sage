// Only the user runs evals. `make eval` costs money and a night of the Mac, so
// `agent/scripts/eval/run.ts` refuses to start when it runs under an agent.
// Claude Code sets CLAUDECODE in the shells it opens for one. The check comes
// before anything else, `--dry-run` and `--help` included, and there is no flag
// that turns it off.
//
// These tests start run.ts for real, but only with `--help` and a bad option,
// so a missing guard would print the usage or a command line error and stop.
// Nothing here plans a sweep, reads the network, or starts a model.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CliError, parseCli, USAGE } from "../agent/scripts/eval/cli.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runFile = join(repoRoot, "agent", "scripts", "eval", "run.ts");
const REFUSAL = "make eval is run by you, not by an agent.";

function runWith(args: string[], claudeCode: string | undefined) {
  const env: Record<string, string | undefined> = { ...process.env };
  env.CLAUDECODE = claudeCode;
  if (claudeCode === undefined) {
    // biome-ignore lint/performance/noDelete: an unset variable and an empty one differ here
    delete env.CLAUDECODE;
  }
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", runFile, ...args],
    { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000 }
  );
}

test("run.ts under an agent exits 2 with the one message and prints nothing else", () => {
  const result = runWith(["--help"], "1");
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), REFUSAL);
  assert.equal(result.stdout, "");
});

test("the refusal comes before the command line is read, so --dry-run and a bad option are refused the same way", () => {
  for (const args of [
    ["--sweep", "smoke", "--dry-run", "--yes"],
    ["--url", "http://localhost:3000"],
    ["--no-such-option"],
    [],
  ]) {
    const result = runWith(args, "1");
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr.trim(), REFUSAL, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});

test("an empty CLAUDECODE is refused too, and nothing starts", () => {
  const result = runWith(["--help"], "");
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), REFUSAL);
});

test("without CLAUDECODE the guard stays out of the way, which shows the refusal is the variable and not a broken script", () => {
  const result = runWith(["--help"], undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(USAGE.split("\n")[0] ?? "usage"));
  assert.ok(!result.stderr.includes(REFUSAL));
});

test("run.ts checks the variable before it imports the command line parser or the runner", () => {
  const source = readFileSync(runFile, "utf8");
  const guard = source.indexOf("agentRefusal(process.env)");
  assert.ok(guard > 0, "run.ts checks the environment");
  for (const later of ['import("./cli.ts")', 'import("./runner.ts")']) {
    assert.ok(source.indexOf(later) > guard, `${later} comes after the check`);
  }
  // The only static import is the guard itself.
  const staticImports = source.match(/^import .* from .*$/gmu) ?? [];
  assert.equal(staticImports.length, 1);
  assert.ok(staticImports[0]?.endsWith('from "./agent-guard.ts";'));
});

test("there is no flag or variable that turns the refusal off", () => {
  // The command line has no such option, and the usage names none.
  for (const flag of ["--allow-agent", "--agent", "--force", "--i-am-the-user"]) {
    assert.throws(() => parseCli([flag]), CliError, flag);
  }
  assert.ok(!/--\S*agent/iu.test(USAGE), "the usage names no agent option");
  // The guard reads one variable, and nothing else in the environment.
  const guard = readFileSync(
    join(repoRoot, "agent", "scripts", "eval", "agent-guard.ts"),
    "utf8"
  );
  assert.deepEqual(guard.match(/env\.[A-Za-z_]+/gu), ["env.CLAUDECODE"]);
});
