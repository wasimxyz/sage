/**
 * The spending ledger for one sweep.
 *
 * Every cloud call reserves its estimated cost before it runs and settles with
 * the real cost after. A reservation that would push the total past the cap is
 * refused, and the caller marks the item "not graded: spending cap".
 *
 * The ledger is `ledger.jsonl` inside the run directory. Several processes
 * write to it at once: the grade pool runs up to two `eve eval` processes, and
 * the person pass and the runner may call the judge as well. A reservation
 * reads the whole file, checks the cap, and appends a line, so those three
 * steps must not interleave with another process's. They run inside an
 * exclusive lock: a `ledger.lock` file created with the `wx` flag, which the
 * operating system makes atomic. A process that finds the lock waits a few
 * milliseconds and tries again. A lock older than `STALE_LOCK_MS` was left by
 * a process that died, and is removed. The work inside the lock is a read and
 * an append, so the lock is held for about a millisecond.
 *
 * Money counts like this:
 * - A settled call counts what it cost.
 * - A reservation never settled counts its estimate, so a crash can only make
 *   the ledger cautious, never lenient.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const LEDGER_FILE = "ledger.jsonl";
export const LEDGER_LOCK_FILE = "ledger.lock";

const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 3;
const RETRY_SPREAD_MS = 17;
const LINE_BREAK = /\r?\n/u;
/** Costs are summed as floats, so compare with a little slack. */
const CAP_SLACK_USD = 1e-12;

interface ReserveLine {
  at: string;
  estimateUsd: number;
  id: string;
  label: string;
  model: string;
  type: "reserve";
}

interface SettleLine {
  at: string;
  cachedInputTokens?: number;
  costUsd: number;
  id: string;
  inputTokens: number;
  model: string;
  outputTokens: number;
  type: "settle";
}

type Line = ReserveLine | SettleLine;

interface Reservation {
  estimateUsd: number;
  settled?: SettleLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseLine(text: string): Line | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A line cut short by a crash.
    return undefined;
  }
  if (!(isRecord(parsed) && typeof parsed.id === "string")) {
    return undefined;
  }
  if (
    parsed.type === "reserve" &&
    isNumber(parsed.estimateUsd) &&
    typeof parsed.model === "string"
  ) {
    return parsed as unknown as ReserveLine;
  }
  if (
    parsed.type === "settle" &&
    isNumber(parsed.costUsd) &&
    typeof parsed.model === "string"
  ) {
    return parsed as unknown as SettleLine;
  }
  return undefined;
}

function readLines(runDir: string): Line[] {
  let raw: string;
  try {
    raw = readFileSync(join(runDir, LEDGER_FILE), "utf8");
  } catch (error) {
    if (isFileError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const lines: Line[] = [];
  for (const text of raw.split(LINE_BREAK)) {
    if (text.trim().length === 0) {
      continue;
    }
    const line = parseLine(text);
    if (line !== undefined) {
      lines.push(line);
    }
  }
  return lines;
}

/** Reservations by id. The first settlement of a reservation wins. */
function fold(lines: readonly Line[]): Map<string, Reservation> {
  const reservations = new Map<string, Reservation>();
  for (const line of lines) {
    if (line.type === "reserve") {
      reservations.set(line.id, { estimateUsd: line.estimateUsd });
      continue;
    }
    const reservation = reservations.get(line.id);
    if (reservation !== undefined && reservation.settled === undefined) {
      reservation.settled = line;
    }
  }
  return reservations;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === code;
}

function removeStaleLock(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_LOCK_MS) {
      unlinkSync(lockPath);
    }
  } catch (error) {
    // Another process released or removed it first.
    if (!isFileError(error, "ENOENT")) {
      throw error;
    }
  }
}

function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return;
    } catch (error) {
      if (!isFileError(error, "EEXIST")) {
        throw error;
      }
    }
    removeStaleLock(lockPath);
    if (Date.now() > deadline) {
      throw new Error(
        `The spending ledger stayed locked for ${LOCK_TIMEOUT_MS / 1000} seconds: ${lockPath}`
      );
    }
    sleepSync(RETRY_MIN_MS + Math.floor(Math.random() * RETRY_SPREAD_MS));
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    // Already gone: a process that judged the lock stale removed it.
    if (!isFileError(error, "ENOENT")) {
      throw error;
    }
  }
}

function withLock<T>(runDir: string, work: () => T): T {
  mkdirSync(runDir, { recursive: true });
  const lockPath = join(runDir, LEDGER_LOCK_FILE);
  acquireLock(lockPath);
  try {
    return work();
  } finally {
    releaseLock(lockPath);
  }
}

function append(runDir: string, line: Line): void {
  appendFileSync(
    join(runDir, LEDGER_FILE),
    `${JSON.stringify(line)}\n`,
    "utf8"
  );
}

function committedUsd(reservations: Map<string, Reservation>): number {
  let total = 0;
  for (const reservation of reservations.values()) {
    total += reservation.settled?.costUsd ?? reservation.estimateUsd;
  }
  return total;
}

function requireAmount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number of dollars, 0 or more.`);
  }
}

/**
 * Reserves `r.estimateUsd` against the cap. Returns the reservation id to
 * settle with, or refuses when the money already spent and reserved plus this
 * estimate would pass `capUsd`. A refused call writes nothing.
 */
export function reserve(
  runDir: string,
  capUsd: number,
  r: { estimateUsd: number; label: string; model: string }
): { id: string; ok: true } | { ok: false; reason: "spending cap" } {
  requireAmount("capUsd", capUsd);
  requireAmount("estimateUsd", r.estimateUsd);
  return withLock(runDir, () => {
    const committed = committedUsd(fold(readLines(runDir)));
    if (committed + r.estimateUsd > capUsd + CAP_SLACK_USD) {
      return { ok: false, reason: "spending cap" } as const;
    }
    const id = randomUUID();
    append(runDir, {
      at: new Date().toISOString(),
      estimateUsd: r.estimateUsd,
      id,
      label: r.label,
      model: r.model,
      type: "reserve",
    });
    return { id, ok: true } as const;
  });
}

/**
 * Replaces a reservation's estimate with what the call really cost. Settling
 * twice keeps the first settlement. Throws for an id that was never reserved.
 */
export function settle(
  runDir: string,
  id: string,
  s: {
    cachedInputTokens?: number;
    costUsd: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
  }
): void {
  requireAmount("costUsd", s.costUsd);
  withLock(runDir, () => {
    if (!fold(readLines(runDir)).has(id)) {
      throw new Error(`No reservation ${id} in the ledger of ${runDir}.`);
    }
    append(runDir, {
      at: new Date().toISOString(),
      ...(s.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: s.cachedInputTokens }),
      costUsd: s.costUsd,
      id,
      inputTokens: s.inputTokens,
      model: s.model,
      outputTokens: s.outputTokens,
      type: "settle",
    });
  });
}

/**
 * What the ledger holds now. `spentUsd` is the cost of settled calls and
 * `reservedUsd` the estimates still waiting to settle, so the cap check is
 * `spentUsd + reservedUsd`. `calls` counts settled calls.
 */
export function totals(runDir: string): {
  byModel: Record<string, { calls: number; spentUsd: number }>;
  calls: number;
  reservedUsd: number;
  spentUsd: number;
} {
  const byModel: Record<string, { calls: number; spentUsd: number }> = {};
  let calls = 0;
  let reservedUsd = 0;
  let spentUsd = 0;
  for (const reservation of fold(readLines(runDir)).values()) {
    const { settled } = reservation;
    if (settled === undefined) {
      reservedUsd += reservation.estimateUsd;
      continue;
    }
    calls += 1;
    spentUsd += settled.costUsd;
    const entry = byModel[settled.model] ?? { calls: 0, spentUsd: 0 };
    entry.calls += 1;
    entry.spentUsd += settled.costUsd;
    byModel[settled.model] = entry;
  }
  return { byModel, calls, reservedUsd, spentUsd };
}
