import { basename, join } from "node:path";

import {
  isDreamStartReady,
  requireOk,
  resultNumber,
} from "../evals/lib/bridge.ts";
import { loadEntryFiles } from "../evals/lib/dataset.ts";
import {
  type Automation,
  automationAt,
  callBridge,
  dreamTimeoutMs,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";
import { OLLAMA_HOST, ollamaApiBase } from "./eval/ollama.ts";
import { localToday, moveToToday } from "./seed-dates.ts";
import {
  attemptProblems,
  CHATS_FILE,
  formatHeldChat,
  holdSeedChats,
  loadSeedChats,
  type SeedChats,
  type SeededChat,
} from "./seed-dev-chats.ts";

// Drives a running automation build of Sage, as seed-dataset.ts does for
// `make eval`. scripts/seed-dev.sh starts that build against the dev journal.
// With --check it only reads the seed files, so the script can refuse a bad
// file before it deletes anything. It saves the entries and stops: Dream and
// Chat are left for you to run.
//
// With SAGE_SEED_CHATS=1 it goes on: Dream reads the entries, the chats in
// the seed folder's chats.yaml are held with the real Chat agent (see
// seed-dev-chats.ts), and Dream runs again to title and summarize them.
// SAGE_DISCOVERY_FILE then names the running Sage's agent-server.json.
//
// The seed folder can be scripts/seed or a person folder such as
// agent/evals/content/data/people/sam-example. Only the *.md files at the top of the
// folder are entries. case.yaml and chats/ are left alone.

const agentDir = join(import.meta.dirname, "..");

async function main(): Promise<void> {
  const seedDir = requiredEnv("SAGE_SEED_DIR");
  const loaded = await loadEntryFiles(seedDir);
  if (loaded.length === 0) {
    throw new Error(
      `${basename(seedDir)} has no markdown entries, so there is nothing to seed.`
    );
  }
  const { days, entries } = moveToToday(loaded, localToday());
  const seedChats =
    process.env.SAGE_SEED_CHATS === "1" ? await loadSeedChats(seedDir) : null;
  if (process.argv.includes("--check")) {
    console.log(`${entries.length} seed entries in ${seedDir}`);
    console.log(
      `Dates move ${days} days, so the newest is ${newestDate(entries)}.`
    );
    if (seedChats !== null) {
      console.log(`${seedChats.chats.length} chats in ${CHATS_FILE}`);
    }
    return;
  }

  const automation = automationAt(requiredEnv("SAGE_AUTOMATION_CWD"));

  waitForAutomation(automation);
  for (const entry of entries) {
    saveJournalEntry(automation, "seed", entry);
    console.log(`saved ${entry.date} ${entry.title}`);
  }
  if (seedChats !== null) {
    await seedDevChats(automation, entries.length, seedChats);
  }
}

/** Dream on the entries, the chats, then Dream on the chats. */
async function seedDevChats(
  automation: Automation,
  entryCount: number,
  seedChats: SeedChats
): Promise<void> {
  const discoveryFile = requiredEnv("SAGE_DISCOVERY_FILE");

  console.log("Dream is reading the entries. This takes a while.");
  runDream(automation, "entries", entryCount);
  const seeded = await holdSeedChats({
    agentDir,
    automation,
    discoveryFile,
    logFile: join(automation.cwd, "chat-agent.log"),
    ollamaApiBase: ollamaApiBase(OLLAMA_HOST),
    seedChats,
  });
  const saved = seeded.filter((chat) => chat.savedId !== null).length;
  if (saved > 0) {
    console.log("Dream is reading the chats.");
    runDream(automation, "chats", saved);
  }
  printChats(seeded);
}

/** Starts Dream and waits for it, as seed-dataset.ts does for `make eval`. */
function runDream(automation: Automation, label: string, items: number): void {
  const started = callBridge(
    automation,
    "dream.start",
    {},
    `seed-dream-start-${label}`,
    isDreamStartReady
  );
  requireOk(started, "dream.start");
  if (resultNumber(started, "total") === 0) {
    throw new Error(`Dream had nothing to read after saving the ${label}.`);
  }
  waitForDream(automation, dreamTimeoutMs(items));
}

function printChats(seeded: readonly SeededChat[]): void {
  console.log("");
  for (const { held, savedId } of seeded) {
    console.log(formatHeldChat(held, savedId));
    console.log("");
  }
  const warned = seeded.filter(
    ({ held, savedId }) =>
      savedId === null || attemptProblems(held.final).length > 0
  );
  if (warned.length > 0) {
    console.log(
      `${warned.length} of ${seeded.length} chats had problems: ${warned.map(({ held }) => held.chat.name).join(", ")}. Read them above.`
    );
  }
}

function newestDate(entries: readonly { date: string }[]): string {
  return entries.reduce(
    // biome-ignore lint/complexity/useMathMinMax: dates are ISO strings, which Math.max turns into NaN
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
