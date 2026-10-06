import {
  errorMessage,
  isDreamStartReady,
  resultNumber,
} from "../evals/lib/bridge.ts";
import { loadEntryFiles } from "../evals/lib/dataset.ts";
import {
  automationAt,
  callBridge,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";

// Drives a running automation build of Sage, as seed-dataset.ts does for
// `make eval`. scripts/seed-dev.sh starts that build against the dev journal.

async function main(): Promise<void> {
  const automationCwd = requiredEnv("SAGE_AUTOMATION_CWD");
  const seedDir = requiredEnv("SAGE_SEED_DIR");

  const entries = await loadEntryFiles(seedDir);
  const automation = automationAt(automationCwd);

  waitForAutomation(automation);
  for (const entry of entries) {
    saveJournalEntry(automation, "seed", entry);
    console.log(`saved ${entry.date} ${entry.title}`);
  }

  const started = callBridge(
    automation,
    "dream.start",
    {},
    "seed-dream-start",
    isDreamStartReady
  );
  if (started.ok === false) {
    const reason = errorMessage(started) ?? "dream.start failed.";
    throw new Error(
      `The entries are saved, but Dream did not start: ${reason}`
    );
  }
  if (resultNumber(started, "total") === 0) {
    console.log("Dream had nothing to do.");
    return;
  }
  waitForDream(automation);
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
