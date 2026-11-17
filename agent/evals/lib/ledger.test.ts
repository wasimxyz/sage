import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  LEDGER_FILE,
  LEDGER_LOCK_FILE,
  reserve,
  settle,
  totals,
} from "./ledger.ts";

const noReservationNopePattern = /No reservation nope/u;

const run = promisify(execFile);
const ledgerUrl = new URL("./ledger.ts", import.meta.url).href;
const EPSILON = 1e-9;

function tempRunDir(): string {
  return join(mkdtempSync(join(tmpdir(), "sage-ledger-")), "run");
}

function close(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${actual} is not ${expected}`
  );
}

function reserveOk(runDir: string, cap: number, estimateUsd: number): string {
  const result = reserve(runDir, cap, {
    estimateUsd,
    label: "test",
    model: "judge/model",
  });
  assert.ok(result.ok, "reservation was refused");
  return result.id;
}

test("totals of a missing ledger are all zero", () => {
  assert.deepEqual(totals(tempRunDir()), {
    byModel: {},
    calls: 0,
    reservedUsd: 0,
    spentUsd: 0,
  });
});

test("reserve creates the run directory and keeps the reservation until it settles", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.25);
  const held = totals(runDir);
  close(held.reservedUsd, 0.25);
  assert.equal(held.spentUsd, 0);
  assert.equal(held.calls, 0);
  assert.ok(existsSync(join(runDir, LEDGER_FILE)));
  assert.ok(
    !existsSync(join(runDir, LEDGER_LOCK_FILE)),
    "the lock file is removed after each call"
  );
});

test("settle replaces the estimate with the real cost", () => {
  const runDir = tempRunDir();
  const id = reserveOk(runDir, 1, 0.5);
  settle(runDir, id, {
    cachedInputTokens: 100,
    costUsd: 0.125,
    inputTokens: 1000,
    model: "judge/model",
    outputTokens: 200,
  });
  const after = totals(runDir);
  close(after.spentUsd, 0.125);
  assert.equal(after.reservedUsd, 0);
  assert.equal(after.calls, 1);
  assert.deepEqual(after.byModel, {
    "judge/model": { calls: 1, spentUsd: 0.125 },
  });
});

test("totals groups settled calls by model", () => {
  const runDir = tempRunDir();
  for (const [model, costUsd] of [
    ["judge/a", 0.1],
    ["judge/b", 0.2],
    ["judge/a", 0.3],
  ] as const) {
    const result = reserve(runDir, 10, { estimateUsd: 1, label: "x", model });
    assert.ok(result.ok);
    settle(runDir, result.id, {
      costUsd,
      inputTokens: 1,
      model,
      outputTokens: 1,
    });
  }
  const { byModel, calls, spentUsd } = totals(runDir);
  assert.equal(calls, 3);
  close(spentUsd, 0.6);
  assert.equal(byModel["judge/a"].calls, 2);
  close(byModel["judge/a"].spentUsd, 0.4);
  assert.equal(byModel["judge/b"].calls, 1);
});

test("reserve refuses an estimate that would pass the cap and writes nothing", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.6);
  const before = readFileSync(join(runDir, LEDGER_FILE), "utf8");
  const refused = reserve(runDir, 1, {
    estimateUsd: 0.5,
    label: "too much",
    model: "judge/model",
  });
  assert.deepEqual(refused, { ok: false, reason: "spending cap" });
  assert.equal(readFileSync(join(runDir, LEDGER_FILE), "utf8"), before);
});

test("reserve allows an estimate that lands exactly on the cap", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.5);
  reserveOk(runDir, 1, 0.5);
  assert.deepEqual(
    reserve(runDir, 1, { estimateUsd: 0.01, label: "x", model: "m" }),
    { ok: false, reason: "spending cap" }
  );
});

test("a settled call frees the difference between its estimate and its cost", () => {
  const runDir = tempRunDir();
  const id = reserveOk(runDir, 1, 0.9);
  assert.equal(
    reserve(runDir, 1, { estimateUsd: 0.5, label: "x", model: "m" }).ok,
    false
  );
  settle(runDir, id, {
    costUsd: 0.1,
    inputTokens: 1,
    model: "m",
    outputTokens: 1,
  });
  assert.equal(
    reserve(runDir, 1, { estimateUsd: 0.5, label: "x", model: "m" }).ok,
    true
  );
});

test("a cap of zero refuses any estimate above zero", () => {
  const runDir = tempRunDir();
  assert.deepEqual(
    reserve(runDir, 0, { estimateUsd: 0.001, label: "x", model: "m" }),
    { ok: false, reason: "spending cap" }
  );
  assert.equal(
    reserve(runDir, 0, { estimateUsd: 0, label: "x", model: "m" }).ok,
    true
  );
});

test("settling twice keeps the first settlement", () => {
  const runDir = tempRunDir();
  const id = reserveOk(runDir, 1, 0.5);
  const base = { inputTokens: 1, model: "m", outputTokens: 1 };
  settle(runDir, id, { ...base, costUsd: 0.1 });
  settle(runDir, id, { ...base, costUsd: 0.4 });
  const after = totals(runDir);
  close(after.spentUsd, 0.1);
  assert.equal(after.calls, 1);
});

test("settle throws for an id that was never reserved", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  assert.throws(
    () =>
      settle(runDir, "nope", {
        costUsd: 0,
        inputTokens: 0,
        model: "m",
        outputTokens: 0,
      }),
    noReservationNopePattern
  );
});

test("reserve and settle reject amounts that are not dollars", () => {
  const runDir = tempRunDir();
  assert.throws(
    () => reserve(runDir, 1, { estimateUsd: -1, label: "x", model: "m" }),
    TypeError
  );
  assert.throws(
    () =>
      reserve(runDir, Number.NaN, { estimateUsd: 1, label: "x", model: "m" }),
    TypeError
  );
  assert.throws(
    () =>
      settle(runDir, "id", {
        costUsd: Number.POSITIVE_INFINITY,
        inputTokens: 0,
        model: "m",
        outputTokens: 0,
      }),
    TypeError
  );
});

test("a line cut short by a crash is ignored", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.25);
  const path = join(runDir, LEDGER_FILE);
  writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"settle","id":"x`);
  close(totals(runDir).reservedUsd, 0.25);
  reserveOk(runDir, 1, 0.25);
});

/** The id of a process that has already exited, so no process has it now. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(typeof pid === "number" && pid > 0);
  return pid;
}

function ledgerFilesIn(runDir: string): string[] {
  return readdirSync(runDir).sort();
}

function writeLock(runDir: string, text: string, ageMs: number): string {
  const lock = join(runDir, LEDGER_LOCK_FILE);
  writeFileSync(lock, text);
  const when = new Date(Date.now() - ageMs);
  utimesSync(lock, when, when);
  return lock;
}

test("a lock left behind by a dead process is taken over at once", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  const lock = writeLock(
    runDir,
    `${deadPid()} 0b9f1c1e-6b1c-4d6f-8d87-2a3c0f1d9a11 2026-11-09T10:00:00.000Z\n`,
    0
  );
  reserveOk(runDir, 1, 0.1);
  close(totals(runDir).reservedUsd, 0.2);
  assert.ok(!existsSync(lock));
  assert.deepEqual(ledgerFilesIn(runDir), [LEDGER_FILE]);
});

test("a lock in the old format, from a dead process, is taken over", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  writeLock(runDir, `${deadPid()} long ago\n`, 60_000);
  reserveOk(runDir, 1, 0.1);
  assert.deepEqual(ledgerFilesIn(runDir), [LEDGER_FILE]);
});

test("a lock with no readable owner is taken over once it is old", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  writeLock(runDir, "", 60_000);
  reserveOk(runDir, 1, 0.1);
  assert.deepEqual(ledgerFilesIn(runDir), [LEDGER_FILE]);
  writeLock(runDir, "not a lock", 60_000);
  reserveOk(runDir, 1, 0.1);
  close(totals(runDir).reservedUsd, 0.3);
  assert.deepEqual(ledgerFilesIn(runDir), [LEDGER_FILE]);
});

/**
 * Plants a lock, starts a process that wants it, lets the lock sit for 400 ms,
 * then removes it. Returns when the removal happened and when the process got
 * its reservation. A process that took the lock over would finish first.
 */
async function waitOutLock(
  runDir: string,
  text: string,
  ageMs: number
): Promise<{ finishedAt: number; removedAt: number }> {
  const lock = writeLock(runDir, text, ageMs);
  const worker = spawnWorker(
    `
    import { reserve } from ${JSON.stringify(ledgerUrl)};
    reserve(process.argv[1], 1, { estimateUsd: 0.1, label: "w", model: "m" });
    process.stdout.write(String(Date.now()));
  `,
    runDir
  );
  await sleep(400);
  const removedAt = Date.now();
  unlinkSync(lock);
  const { stdout } = await worker;
  return { finishedAt: Number(stdout), removedAt };
}

test("a lock held by a live process is never taken over, however old", async () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  const mine = `${process.pid} 7c1d5e0a-2f4b-4c1b-9d3e-5a6b7c8d9e0f 2026-11-09T10:00:00.000Z\n`;
  const { finishedAt, removedAt } = await waitOutLock(runDir, mine, 3_600_000);
  assert.ok(
    finishedAt >= removedAt,
    `the lock was taken over ${removedAt - finishedAt} ms before its owner released it`
  );
  close(totals(runDir).reservedUsd, 0.2);
});

test("a lock with no readable owner is left alone while it is new", async () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  // This is how a lock looks in the moment between its creation and its first write.
  const { finishedAt, removedAt } = await waitOutLock(runDir, "", 0);
  assert.ok(finishedAt >= removedAt);
  close(totals(runDir).reservedUsd, 0.2);
});

function spawnWorker(source: string, runDir: string) {
  return run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      source,
      runDir,
    ],
    { cwd: fileURLToPath(new URL(".", import.meta.url)) }
  );
}

/** Replays the ledger in file order and returns the most it ever held at once. */
function peakCommitted(runDir: string): number {
  const open = new Map<string, number>();
  let settled = 0;
  let peak = 0;
  for (const text of readFileSync(join(runDir, LEDGER_FILE), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)) {
    const line = JSON.parse(text);
    if (line.type === "reserve") {
      open.set(line.id, line.estimateUsd);
    } else if (open.delete(line.id)) {
      settled += line.costUsd;
    }
    let committed = settled;
    for (const estimate of open.values()) {
      committed += estimate;
    }
    peak = Math.max(peak, committed);
  }
  return peak;
}

test("two processes that reserve and settle never hold more than the cap", async () => {
  const runDir = tempRunDir();
  const cap = 30;
  // Each worker reserves $1 forty times against a $30 cap and settles what it
  // got at $0.50, so room keeps opening up while eighty attempts compete.
  const worker = `
    import { reserve, settle } from ${JSON.stringify(ledgerUrl)};
    const runDir = process.argv[1];
    let granted = 0;
    for (let i = 0; i < 40; i++) {
      const r = reserve(runDir, ${cap}, { estimateUsd: 1, label: "w", model: "m" });
      if (r.ok) {
        granted += 1;
        settle(runDir, r.id, { costUsd: 0.5, inputTokens: 1, model: "m", outputTokens: 1 });
      }
    }
    process.stdout.write(String(granted));
  `;
  const [a, b] = await Promise.all([
    spawnWorker(worker, runDir),
    spawnWorker(worker, runDir),
  ]);
  const granted = Number(a.stdout) + Number(b.stdout);
  const after = totals(runDir);
  assert.equal(after.calls, granted);
  close(after.spentUsd, granted * 0.5);
  assert.equal(after.reservedUsd, 0);
  assert.ok(granted >= cap, `only ${granted} were granted`);
  assert.ok(
    peakCommitted(runDir) <= cap + EPSILON,
    "the ledger held more than the cap at once"
  );
  assert.ok(!existsSync(join(runDir, LEDGER_LOCK_FILE)));
});

test("two processes that do not settle are held to exactly the cap", async () => {
  const runDir = tempRunDir();
  const cap = 25;
  const worker = `
    import { reserve } from ${JSON.stringify(ledgerUrl)};
    const runDir = process.argv[1];
    let granted = 0;
    for (let i = 0; i < 40; i++) {
      if (reserve(runDir, ${cap}, { estimateUsd: 1, label: "w", model: "m" }).ok) {
        granted += 1;
      }
    }
    process.stdout.write(String(granted));
  `;
  const [a, b] = await Promise.all([
    spawnWorker(worker, runDir),
    spawnWorker(worker, runDir),
  ]);
  assert.equal(Number(a.stdout) + Number(b.stdout), cap);
  close(totals(runDir).reservedUsd, cap);
});

// ---------------------------------------------------------------------------
// Taking over a stale lock while another process does the same
// ---------------------------------------------------------------------------

const SLEEP_SOURCE =
  "(ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)";

/**
 * A worker that reserves $1 against a $1 cap, with `hooks` wrapped around the
 * file system calls it makes. The hooks stand in for the scheduler pausing a
 * process at a bad moment. The worker waits for `startAt` first, so two of
 * them begin together. It prints whether it got the reservation and how many
 * times a hook fired.
 */
function racer(label: string, hooks: string): string {
  return `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const sleep = ${SLEEP_SOURCE};
    const [runDir, startAt] = [process.argv[1], Number(process.argv[2])];
    let hits = 0;
    ${hooks}
    syncBuiltinESMExports();
    const { reserve } = await import(${JSON.stringify(ledgerUrl)});
    while (Date.now() < startAt) {}
    const ok = reserve(runDir, 1, { estimateUsd: 1, label: ${JSON.stringify(label)}, model: "m" }).ok;
    process.stdout.write(JSON.stringify({ hits, ok }));
  `;
}

/** The slow process pauses for 150 ms right after it looks at the stale lock. */
const PAUSE_AFTER_LOOKING = `
  const realStat = fs.statSync;
  let paused = false;
  fs.statSync = function (path, ...rest) {
    const stats = realStat.call(fs, path, ...rest);
    if (!paused && String(path).endsWith("ledger.lock")) {
      paused = true;
      hits += 1;
      sleep(150);
    }
    return stats;
  };
`;

/** The slow process pauses for 150 ms right before it moves the stale lock. */
const PAUSE_BEFORE_MOVING = `
  const realRename = fs.renameSync;
  fs.renameSync = function (from, ...rest) {
    if (String(from).endsWith("ledger.lock")) {
      hits += 1;
      sleep(150);
    }
    return realRename.call(fs, from, ...rest);
  };
`;

/** The quick process holds the lock for 400 ms after it reads the ledger. */
const PAUSE_INSIDE_LOCK = `
  const realRead = fs.readFileSync;
  let held = false;
  fs.readFileSync = function (path, ...rest) {
    const out = realRead.call(fs, path, ...rest);
    if (!held && String(path).endsWith("ledger.jsonl")) {
      held = true;
      hits += 1;
      sleep(400);
    }
    return out;
  };
`;

function spawnRacer(source: string, runDir: string, startAt: number) {
  return run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      source,
      runDir,
      String(startAt),
    ],
    { cwd: fileURLToPath(new URL(".", import.meta.url)) }
  );
}

/**
 * Two processes find a lock its owner left behind. The slow one pauses with
 * `slowHooks`. The quick one starts 40 ms later, takes the lock over, and
 * holds it for 400 ms. When the slow one wakes, the lock it judged stale is
 * gone and the quick one's live lock is in its place. It must not remove that
 * lock, or both would read the ledger before either wrote and both would pass
 * a $1 cap.
 */
async function raceForStaleLock(slowHooks: string): Promise<void> {
  const runDir = join(mkdtempSync(join(tmpdir(), "sage-ledger-race-")), "run");
  // A crashed process left the lock behind, and the ledger already exists.
  reserveOk(runDir, 10, 0);
  writeLock(
    runDir,
    `${deadPid()} 3f6c2a58-5d3e-4b0a-9e47-8c1d2b7a6f10 2026-11-09T10:00:00.000Z\n`,
    60_000
  );
  const startAt = Date.now() + 2500;
  const [slow, quick] = (
    await Promise.all([
      spawnRacer(racer("slow", slowHooks), runDir, startAt),
      spawnRacer(racer("quick", PAUSE_INSIDE_LOCK), runDir, startAt + 40),
    ])
  ).map((out) => JSON.parse(out.stdout) as { hits: number; ok: boolean });
  assert.equal(slow.hits, 1, "the slow process was never paused");
  assert.equal(quick.hits, 1, "the quick process never held the lock");
  assert.equal(quick.ok, true, "the process that held the lock got no room");
  assert.equal(slow.ok, false, "both reservations passed a $1 cap");
  close(totals(runDir).reservedUsd, 1);
  assert.deepEqual(
    ledgerFilesIn(runDir),
    [LEDGER_FILE],
    "a lock or a moved lock was left behind"
  );
}

test("a process that looked at a stale lock, then paused, leaves the lock that replaced it", async () => {
  await raceForStaleLock(PAUSE_AFTER_LOOKING);
});

test("a process that moves the lock that replaced the stale one gives it back", async () => {
  await raceForStaleLock(PAUSE_BEFORE_MOVING);
});
