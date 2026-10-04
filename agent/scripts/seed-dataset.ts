import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  dreamPollState,
  firstJsonObject,
  isDreamStartReady,
  isMatchingId,
  matchingBridgeResponse,
  nextAutomationSequence,
  parseBridgeJson,
  requireOk,
  resultBoolean,
  resultNumber,
  utf8Chunks,
} from "../evals/lib/bridge.ts";
import {
  type EvalCase,
  type EvalManifest,
  type JournalEntryFixture,
  loadAllCases,
} from "../evals/lib/dataset.ts";

const automationCwd = process.env.SAGE_AUTOMATION_CWD ?? process.cwd();
const automationDir = join(
  automationCwd,
  ".zig-cache",
  "native-sdk-automation"
);
const responseFile = join(automationDir, "bridge-response.txt");
const chunkBytes = 4000;
const dreamTimeoutMs = 30 * 60 * 1000;
const dreamPollMs = 2000;

async function main(): Promise<void> {
  const manifestPath = process.env.SAGE_EVAL_MANIFEST;
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("SAGE_EVAL_MANIFEST is not set.");
  }

  waitForAutomation();
  const wipe = callBridge("data.deleteAll", {}, "eval-wipe");
  requireOk(wipe, "data.deleteAll");

  const cases = await loadAllCases();
  if (cases.length === 0) {
    throw new Error("No eval fixtures found under evals/data.");
  }

  const manifest: EvalManifest = { cases: {} };
  for (const fixture of cases) {
    const journalIds: number[] = [];
    for (const entry of fixture.entries) {
      journalIds.push(saveEntry(fixture, entry));
    }
    manifest.cases[fixture.id] = { journalIds };
    console.log(`seeded ${fixture.id}: ${journalIds.join(", ")}`);
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const started = callBridge(
    "dream.start",
    {},
    "eval-dream-start",
    isDreamStartReady
  );
  requireOk(started, "dream.start");
  console.log(`dream.start ${JSON.stringify(started)}`);
  const startTotal = resultNumber(started, "total");
  if (startTotal === 0) {
    throw new Error("Dream had nothing to process. Seeding may have failed.");
  }
  waitForDream();
}

function saveEntry(fixture: EvalCase, entry: JournalEntryFixture): number {
  const chunks = utf8Chunks(entry.body, chunkBytes);
  let savedId: number | null = null;
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    const done = index === chunks.length - 1;
    const requestId = `save-${fixture.id}-${entry.index}-${index}`;
    console.log(requestId);
    const response = callBridge(
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
      requestId
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
      `Save did not return an id for ${fixture.id} entry ${entry.index}.`
    );
  }
  return savedId;
}

function waitForDream(): void {
  const started = Date.now();
  let sawRunning = false;
  while (Date.now() - started < dreamTimeoutMs) {
    const status = callBridge("dream.status", {}, "eval-dream-status");
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

function waitForAutomation(): void {
  const result = spawnSync("native", ["automate", "wait"], {
    cwd: automationCwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "native automate wait failed"
    );
  }
}

function callBridge(
  command: string,
  payload: Record<string, unknown>,
  id: string,
  ready: (response: Record<string, unknown>) => boolean = isMatchingId
): Record<string, unknown> {
  mkdirSync(automationDir, { recursive: true });
  const request = JSON.stringify({ command, id, payload });
  const sequence = nextAutomationSequence(readdirSync(automationDir));
  writeFileSync(
    join(automationDir, `command-${sequence}.txt`),
    `bridge ${request}\n`
  );
  return waitForBridgeResponse(id, ready);
}

function waitForBridgeResponse(
  id: string,
  ready: (response: Record<string, unknown>) => boolean
): Record<string, unknown> {
  const deadline = Date.now() + 60_000;
  let lastMatch: Record<string, unknown> | null = null;
  let lastSeen: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    const raw = readIfPresent(responseFile);
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

await main();
