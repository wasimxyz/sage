import { loadEntryFiles } from "../evals/lib/dataset.ts";
import {
  automationAt,
  saveJournalEntry,
  waitForAutomation,
} from "./automation.ts";
import { localToday, moveToToday } from "./seed-dates.ts";

// Drives a running automation build of Sage, as seed-dataset.ts does for
// `make eval`. scripts/seed-dev.sh starts that build against the dev journal.
// With --check it only reads the seed files, so the script can refuse a bad
// file before it deletes anything. It saves the entries and stops: Dream and
// Chat are left for you to run.

async function main(): Promise<void> {
  const seedDir = requiredEnv("SAGE_SEED_DIR");
  const { days, entries } = moveToToday(
    await loadEntryFiles(seedDir),
    localToday()
  );
  if (process.argv.includes("--check")) {
    console.log(`${entries.length} seed entries in ${seedDir}`);
    console.log(
      `Dates move ${days} days, so the newest is ${newestDate(entries)}.`
    );
    return;
  }

  const automation = automationAt(requiredEnv("SAGE_AUTOMATION_CWD"));

  waitForAutomation(automation);
  for (const entry of entries) {
    saveJournalEntry(automation, "seed", entry);
    console.log(`saved ${entry.date} ${entry.title}`);
  }
}

function newestDate(entries: readonly { date: string }[]): string {
  return entries.reduce(
    (newest, entry) => (entry.date > newest ? entry.date : newest),
    ""
  );
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
