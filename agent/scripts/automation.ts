import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  dreamPollState,
  firstJsonObject,
  isMatchingId,
  matchingBridgeResponse,
  nextAutomationSequence,
  parseBridgeJson,
  requireOk,
  resultBoolean,
  resultNumber,
  utf8Chunks,
} from "../evals/lib/bridge.ts";
import type { LoadedEntry } from "../evals/lib/dataset.ts";

const chunkBytes = 4000;
const minDreamTimeoutMs = 30 * 60 * 1000;
// Dream takes about a minute per entry with memory on. Allow far more, so a
// slow model or a long journal still finishes, and a stuck run still ends.
const dreamTimeoutPerEntryMs = 150_000;
const dreamPollMs = 2000;
const bridgeTimeoutMs = 60_000;

/** How long to wait for Dream, by the number of entries (and chats) it reads. */
export function dreamTimeoutMs(items: number): number {
  return Math.max(minDreamTimeoutMs, items * dreamTimeoutPerEntryMs);
}

/** Where a running automation build of Sage keeps its command files. */
export interface Automation {
  cwd: string;
  dir: string;
  responseFile: string;
}

export function automationAt(cwd: string): Automation {
  const dir = join(cwd, ".zig-cache", "native-sdk-automation");
  return { cwd, dir, responseFile: join(dir, "bridge-response.txt") };
}

export function waitForAutomation(automation: Automation): void {
  const result = spawnSync("native", ["automate", "wait"], {
    cwd: automation.cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "native automate wait failed"
    );
  }
}

/**
 * No answer came for a bridge request in time. The automation server keeps
 * only the last response, so a page that is making its own bridge calls can
 * write over the answer before it is read.
 */
export class BridgeTimeoutError extends Error {}

export function callBridge(
  automation: Automation,
  command: string,
  payload: Record<string, unknown>,
  id: string,
  ready: (response: Record<string, unknown>) => boolean = isMatchingId,
  timeoutMs: number = bridgeTimeoutMs
): Record<string, unknown> {
  mkdirSync(automation.dir, { recursive: true });
  const request = JSON.stringify({ command, id, payload });
  const sequence = nextAutomationSequence(readdirSync(automation.dir));
  writeFileSync(
    join(automation.dir, `command-${sequence}.txt`),
    `bridge ${request}\n`
  );
  return waitForBridgeResponse(automation, id, ready, timeoutMs);
}

/**
 * Saves one entry through `journal.save`, in chunks, and returns its id.
 * `label` names the request ids, so a repeat run never matches an old answer.
 */
export function saveJournalEntry(
  automation: Automation,
  label: string,
  entry: LoadedEntry
): number {
  const chunks = utf8Chunks(entry.body, chunkBytes);
  let savedId: number | null = null;
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    const done = index === chunks.length - 1;
    const response = callBridge(
      automation,
      "journal.save",
      {
        chunk,
        date: entry.date,
        done,
        format: "markdown",
        id: savedId,
        offset,
        title: entry.title,
        wordCount: entry.wordCount,
      },
      `save-${label}-${entry.index}-${index}`
    );
    requireOk(response, "journal.save");
    const id = resultNumber(response, "id");
    if (Number.isFinite(id) && id > 0) {
      savedId = id;
    }
    offset += Buffer.byteLength(chunk, "utf8");
  }
  if (savedId === null) {
    throw new Error(
      `Save did not return an id for ${label} entry ${entry.index}.`
    );
  }
  return savedId;
}

export function waitForDream(
  automation: Automation,
  timeoutMs = minDreamTimeoutMs
): void {
  const started = Date.now();
  let sawRunning = false;
  while (Date.now() - started < timeoutMs) {
    const status = callBridge(
      automation,
      "dream.status",
      {},
      "eval-dream-status"
    );
    requireOk(status, "dream.status");
    const running = resultBoolean(status, "running");
    const done = resultNumber(status, "done");
    const total = resultNumber(status, "total");
    console.log(`dream ${done}/${total} running=${running}`);
    if (running) {
      sawRunning = true;
    }
    if (dreamPollState(running, done, total, sawRunning) === "done") {
      return;
    }
    sleep(dreamPollMs);
  }
  throw new Error("Dream did not finish before the timeout.");
}

function waitForBridgeResponse(
  automation: Automation,
  id: string,
  ready: (response: Record<string, unknown>) => boolean,
  timeoutMs: number
): Record<string, unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastMatch: Record<string, unknown> | null = null;
  let lastSeen: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    const raw = readIfPresent(automation.responseFile);
    const parsed = parseBridgeJson(firstJsonObject(raw));
    if (parsed !== null) {
      lastSeen = parsed;
    }
    const match = matchingBridgeResponse(id, raw);
    if (match !== null) {
      lastMatch = match;
      if (ready(match)) {
        return match;
      }
    }
    sleep(20);
  }
  throw new BridgeTimeoutError(
    `Bridge ${id} did not finish. Last matching response: ${JSON.stringify(lastMatch)}. Last seen: ${JSON.stringify(lastSeen)}`
  );
}

function readIfPresent(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function sleep(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)]);
}
