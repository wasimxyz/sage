// Seeds one person into the throwaway Sage in SAGE_AUTOMATION_CWD, writes the
// journal-id manifest, and waits for Dream. The runner starts this script once
// per person, on a Dream cache miss. `SAGE_EVAL_PERSON` names the person and
// `SAGE_EVAL_MANIFEST` says where the manifest goes.
//
// `SAGE_EVAL_SEED_STAGE` splits the work in two for a person with past chats:
//
//   content   save the entries and the past chats, index the chats, write the
//             manifest. The runner then stops Sage, rewrites the chats' times
//             to their own dates, and starts Sage again.
//   dream     run Dream and wait for it, so Dream reads the chats at their dates.
//   all       both, in one go. The default, and only for a person with no chats.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ENV_SEED_STAGE,
  isDreamStartReady,
  requireOk,
  resultNumber,
  SEED_STAGES,
  type SeedStage,
} from "../evals/lib/bridge.ts";
import {
  type LoadedPerson,
  loadPerson,
  type Manifest,
} from "../evals/lib/dataset.ts";
import {
  type Automation,
  automationAt,
  callBridge,
  dreamTimeoutMs,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";
import { type BridgeCall, seedChats } from "./seed-chats.ts";

const automation = automationAt(
  process.env.SAGE_AUTOMATION_CWD ?? process.cwd()
);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function readStage(): SeedStage {
  const raw = process.env[ENV_SEED_STAGE];
  if (raw === undefined || raw.length === 0) {
    return "all";
  }
  const found = SEED_STAGES.find((stage) => stage === raw);
  if (found === undefined) {
    throw new Error(
      `${ENV_SEED_STAGE} is "${raw}". Use one of: ${SEED_STAGES.join(", ")}.`
    );
  }
  return found;
}

function bridgeOf(target: Automation): BridgeCall {
  return (command, payload, id) => callBridge(target, command, payload, id);
}

/** Wipes the journal, then saves the entries and the past chats. Writes the manifest. */
function seedContent(person: LoadedPerson, manifestPath: string): void {
  const wipe = callBridge(automation, "data.deleteAll", {}, "eval-wipe");
  requireOk(wipe, "data.deleteAll");

  const journalIds: number[] = [];
  for (const entry of person.entries) {
    journalIds.push(saveJournalEntry(automation, person.id, entry));
  }
  console.log(`seeded ${person.id}: ${journalIds.join(", ")}`);

  const chatIds = seedChats(bridgeOf(automation), person.id, person.chats);
  if (chatIds.length > 0) {
    console.log(`seeded ${person.id} past chats: ${chatIds.join(", ")}`);
  }
  const manifest: Manifest = {
    cases: {
      [person.id]:
        chatIds.length > 0 ? { chatIds, journalIds } : { journalIds },
    },
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Starts Dream and waits for it. */
function runDream(person: LoadedPerson): void {
  const sources = person.entries.length + person.chats.length;
  if (sources === 0) {
    // An empty journal has nothing for Dream to read.
    console.log(`${person.id} has no entries; Dream has nothing to do.`);
    return;
  }
  const started = callBridge(
    automation,
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
  waitForDream(automation, dreamTimeoutMs(sources));
}

async function main(): Promise<void> {
  const manifestPath = requiredEnv("SAGE_EVAL_MANIFEST");
  const personId = requiredEnv("SAGE_EVAL_PERSON");
  const stage = readStage();

  waitForAutomation(automation);
  const person = await loadPerson(personId);
  if (stage === "all" && person.chats.length > 0) {
    throw new Error(
      `${personId} has past chats, so the seed runs in two stages with the chat times rewritten between them. Set ${ENV_SEED_STAGE} to content, then dream.`
    );
  }
  if (stage !== "dream") {
    seedContent(person, manifestPath);
  }
  if (stage !== "content") {
    runDream(person);
  }
}

await main();
