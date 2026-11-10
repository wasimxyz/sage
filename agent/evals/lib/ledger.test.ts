import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("a lock left behind by a dead process is removed once it is old", () => {
  const runDir = tempRunDir();
  reserveOk(runDir, 1, 0.1);
  const lock = join(runDir, LEDGER_LOCK_FILE);
  writeFileSync(lock, "99999 long ago\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  reserveOk(runDir, 1, 0.1);
  close(totals(runDir).reservedUsd, 0.2);
  assert.ok(!existsSync(lock));
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
