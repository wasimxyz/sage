import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  captureCommand,
  hasExited,
  readLogTail,
  runCommand,
  spawnTracked,
  stopProcess,
  succeeded,
  trackedCount,
  waitFor,
} from "./proc.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern1 = /hello \[redacted\]/u;
const pattern2 = /oops/u;
const pattern3 = /secret-value-123/u;

const env = { PATH: process.env.PATH ?? "" };

test("waitFor returns when the check turns true", async () => {
  let calls = 0;
  const result = await waitFor(
    () => {
      calls += 1;
      return calls >= 3;
    },
    { intervalMs: 5, timeoutMs: 2000 }
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test("waitFor times out, and giveUp ends it early with a reason", async () => {
  const timedOut = await waitFor(() => false, { intervalMs: 5, timeoutMs: 40 });
  assert.deepEqual(timedOut, { ok: false, reason: "timed out" });
  const gaveUp = await waitFor(() => false, {
    giveUp: () => "the server exited",
    intervalMs: 5,
    timeoutMs: 5000,
  });
  assert.deepEqual(gaveUp, { ok: false, reason: "the server exited" });
});

test("runCommand logs output, hides secrets, and reports the exit code", async (t) => {
  const dir = tempDir(t);
  const logFile = join(dir, "logs", "run.log");
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "console.log('hello secret-value-123'); console.error('oops'); process.exit(3)",
    ],
    { env, logFile, redactions: ["secret-value-123"] }
  );
  assert.equal(result.code, 3);
  assert.equal(succeeded(result), false);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, pattern1);
  assert.match(log, pattern2);
  assert.doesNotMatch(log, pattern3);

  const ok = await runCommand(process.execPath, ["-e", "0"], { env, logFile });
  assert.equal(succeeded(ok), true);
});

test("runCommand reports a command that cannot start", async (t) => {
  const dir = tempDir(t);
  const result = await runCommand(join(dir, "no-such-command"), [], {
    env,
    logFile: join(dir, "run.log"),
  });
  assert.equal(result.code, null);
  assert.equal(succeeded(result), false);
});

test("captureCommand returns stdout, stderr, and the exit code", async () => {
  const result = await captureCommand(
    process.execPath,
    ["-e", "console.log('out'); console.error('err'); process.exit(2)"],
    { env }
  );
  assert.equal(result.code, 2);
  assert.equal(result.stdout.trim(), "out");
  assert.equal(result.stderr.trim(), "err");
});

test("a tracked child is stopped with SIGTERM", async (t) => {
  const dir = tempDir(t);
  const before = trackedCount();
  const child = spawnTracked(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000); console.log('up')"],
    { detached: true, env, logFile: join(dir, "child.log") }
  );
  assert.equal(trackedCount(), before + 1);
  await waitFor(() => readLogTail(join(dir, "child.log")).includes("up"), {
    intervalMs: 10,
    timeoutMs: 5000,
  });
  await stopProcess(child, { graceMs: 5000, group: true });
  assert.equal(hasExited(child), true);
  assert.equal(child.signalCode, "SIGTERM");
  await waitFor(() => trackedCount() === before, {
    intervalMs: 10,
    timeoutMs: 2000,
  });
  assert.equal(trackedCount(), before);
});

test("a child that ignores SIGTERM is killed after the grace period", async (t) => {
  const dir = tempDir(t);
  const child = spawnTracked(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('stubborn')",
    ],
    { detached: true, env, logFile: join(dir, "child.log") }
  );
  await waitFor(
    () => readLogTail(join(dir, "child.log")).includes("stubborn"),
    { intervalMs: 10, timeoutMs: 5000 }
  );
  await stopProcess(child, { graceMs: 100, group: true });
  assert.equal(hasExited(child), true);
  assert.equal(child.signalCode, "SIGKILL");
});

test("readLogTail gives nothing for a missing file", (t) => {
  const dir = tempDir(t);
  assert.equal(readLogTail(join(dir, "missing.log")), "");
});
