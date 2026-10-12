import {
  errorMessage,
  isDreamStartReady,
  resultNumber,
} from "../evals/lib/bridge.ts";
import { loadEntryFiles } from "../evals/lib/dataset.ts";
import {
  type Automation,
  automationAt,
  callBridge,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";

// Drives a running automation build of Sage, as seed-dataset.ts does for
// `make eval`. scripts/seed-dev.sh starts that build against the dev journal.
// With --check it only reads the seed files, so the script can refuse a bad
// file before it deletes anything.

async function main(): Promise<void> {
  const seedDir = requiredEnv("SAGE_SEED_DIR");
  const entries = await loadEntryFiles(seedDir);
  if (process.argv.includes("--check")) {
    console.log(`${entries.length} seed entries in ${seedDir}`);
    return;
  }

  const automation = automationAt(requiredEnv("SAGE_AUTOMATION_CWD"));

  waitForAutomation(automation);
  for (const entry of entries) {
    saveJournalEntry(automation, "seed", entry);
    console.log(`saved ${entry.date} ${entry.title}`);
  }

  const total = startDream(automation, "seed-dream-start", "start");
  if (total === 0) {
    throw new Error("The entries are saved, but Dream had nothing to process.");
  }
  waitForDream(automation);

  // A run ends the same way whether or not every item worked, and Dream clears
  // its counts when it ends. An item that failed stays pending, so asking for
  // another run lists exactly what is left.
  const left = startDream(automation, "seed-dream-check", "finish");
  if (left > 0) {
    throw new Error(
      `The entries are saved, but Dream left ${left} of ${entries.length} unfinished.`
    );
  }
}

function startDream(
  automation: Automation,
  id: string,
  verb: "start" | "finish"
): number {
  const started = callBridge(
    automation,
    "dream.start",
    {},
    id,
    isDreamStartReady
  );
  if (started.ok === false) {
    const reason = errorMessage(started) ?? "dream.start failed.";
    throw new Error(
      `The entries are saved, but Dream did not ${verb}: ${reason}`
    );
  }
  return resultNumber(started, "total");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
