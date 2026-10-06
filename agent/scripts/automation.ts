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
import type { JournalEntryFixture } from "../evals/lib/dataset.ts";

const chunkBytes = 4000;
const dreamTimeoutMs = 30 * 60 * 1000;
const dreamPollMs = 2000;
const bridgeTimeoutMs = 60_000;

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

export function callBridge(
  automation: Automation,
  command: string,
  payload: Record<string, unknown>,
  id: string,
  ready: (response: Record<string, unknown>) => boolean = isMatchingId
): Record<string, unknown> {
  mkdirSync(automation.dir, { recursive: true });
  const request = JSON.stringify({ command, id, payload });
  const sequence = nextAutomationSequence(readdirSync(automation.dir));
  writeFileSync(
    join(automation.dir, `command-${sequence}.txt`),
    `bridge ${request}\n`
  );
  return waitForBridgeResponse(automation, id, ready);
}

/**
 * Saves one entry through `journal.save`, in chunks, and returns its id.
 * `label` names the request ids, so a repeat run never matches an old answer.
 */
export function saveJournalEntry(
  automation: Automation,
  label: string,
  entry: JournalEntryFixture
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

export function waitForDream(automation: Automation): void {
  const started = Date.now();
  let sawRunning = false;
  while (Date.now() - started < dreamTimeoutMs) {
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
  ready: (response: Record<string, unknown>) => boolean
): Record<string, unknown> {
  const deadline = Date.now() + bridgeTimeoutMs;
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
  throw new Error(
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
