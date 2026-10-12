import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isDreamStartReady,
  requireOk,
  resultNumber,
} from "../evals/lib/bridge.ts";
import { type EvalManifest, loadAllCases } from "../evals/lib/dataset.ts";
import {
  automationAt,
  callBridge,
  saveJournalEntry,
  waitForAutomation,
  waitForDream,
} from "./automation.ts";

const automation = automationAt(
  process.env.SAGE_AUTOMATION_CWD ?? process.cwd()
);

async function main(): Promise<void> {
  const manifestPath = process.env.SAGE_EVAL_MANIFEST;
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("SAGE_EVAL_MANIFEST is not set.");
  }

  waitForAutomation(automation);
  const wipe = callBridge(automation, "data.deleteAll", {}, "eval-wipe");
  requireOk(wipe, "data.deleteAll");

  const cases = await loadAllCases();
  if (cases.length === 0) {
    throw new Error("No eval fixtures found under evals/data.");
  }

  const manifest: EvalManifest = { cases: {} };
  for (const fixture of cases) {
    const journalIds: number[] = [];
    for (const entry of fixture.entries) {
      journalIds.push(saveJournalEntry(automation, fixture.id, entry));
    }
    manifest.cases[fixture.id] = { journalIds };
    console.log(`seeded ${fixture.id}: ${journalIds.join(", ")}`);
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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
  waitForDream(automation);
}

await main();
