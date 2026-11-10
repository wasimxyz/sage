// Seeds one person into the throwaway Sage in SAGE_AUTOMATION_CWD, writes the
// journal-id manifest, and waits for Dream. The runner starts this script once
// per person, on a Dream cache miss. `SAGE_EVAL_PERSON` names the person and
// `SAGE_EVAL_MANIFEST` says where the manifest goes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isDreamStartReady,
  requireOk,
  resultNumber,
} from "../evals/lib/bridge.ts";
import { loadPerson, type Manifest } from "../evals/lib/dataset.ts";
import {
  automationAt,
  callBridge,
  dreamTimeoutMs,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";

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

async function main(): Promise<void> {
  const manifestPath = requiredEnv("SAGE_EVAL_MANIFEST");
  const personId = requiredEnv("SAGE_EVAL_PERSON");

  waitForAutomation(automation);
  const wipe = callBridge(automation, "data.deleteAll", {}, "eval-wipe");
  requireOk(wipe, "data.deleteAll");

  const person = await loadPerson(personId);
  const journalIds: number[] = [];
  for (const entry of person.entries) {
    journalIds.push(saveJournalEntry(automation, person.id, entry));
  }
  const manifest: Manifest = { cases: { [person.id]: { journalIds } } };
  console.log(`seeded ${person.id}: ${journalIds.join(", ")}`);

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (person.entries.length === 0) {
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
  waitForDream(automation, dreamTimeoutMs(person.entries.length));
}

await main();
