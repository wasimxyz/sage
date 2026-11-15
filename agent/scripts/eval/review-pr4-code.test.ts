// Review repros for PR 4 (search, slips, memory pressure, past chats). Each
// test states what should happen and fails on the PR 4 branch.

import assert from "node:assert/strict";
import test from "node:test";

import { localDayOf } from "../../agent/lib/when.ts";
import { showsInternals } from "../../evals/lib/slips.ts";
import { chatTimestamp } from "./chat-times.ts";
import {
  type MemoryProbes,
  type MemoryReading,
  measureMemory,
} from "./memory-pressure.ts";

function swapText(usedMB: number): string {
  return `vm.swapusage: total = 4096.00M  used = ${usedMB.toFixed(2)}M  free = ${(4096 - usedMB).toFixed(2)}M  (encrypted)\n`;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test("repro: measureMemory takes its last sample even when a tick's sample is still out", async () => {
  // Swap is 100 MB before the pass and 900 MB from then on. The first tick's
  // look at swap is slow (a slow sysctl, or /api/ps waiting on a busy Ollama).
  let looks = 0;
  let release: () => void = () => undefined;
  const probes: MemoryProbes = {
    loadedModels: () => Promise.resolve([]),
    swapUsage: () => {
      looks += 1;
      if (looks === 1) {
        return Promise.resolve(swapText(100));
      }
      if (looks === 2) {
        return new Promise<string>((resolve) => {
          release = () => resolve(swapText(900));
        });
      }
      return Promise.resolve(swapText(900));
    },
  };
  const readings: MemoryReading[] = [];
  await measureMemory(probes, () => sleep(40), {
    intervalMs: 10,
    onReading: (reading) => readings.push(reading),
  });
  const looksWhenDone = looks;
  release();
  await sleep(5);
  // The "last sample when the work is done" never looked at swap, and the
  // reading was handed on before the sample that was out came back.
  assert.equal(looksWhenDone, 3, "the last sample did not look at swap");
  assert.equal(readings[0]?.peakGrowthMB, 800);
});

test("repro: shows-internals leaves ordinary prose alone", () => {
  for (const reply of [
    "Nobody hands you the user manual for a newborn, and you are figuring it out at 3am. That is a lot to carry, and it makes sense you feel wrung out.",
    "Your job search results have not come back yet, and waiting is hard. You have been patient with it for weeks, and that counts for something real.",
  ]) {
    const finding = showsInternals(reply);
    assert.equal(finding.flagged, false, finding.reason);
  }
});

test("repro: a rewritten chat lands on its own day in every time zone, as chat-times.ts says", (t) => {
  const before = process.env.TZ;
  t.after(() => {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  });
  process.env.TZ = "Pacific/Auckland";
  // search_chats shows a chat's day, and filters by `when`, in local days.
  assert.equal(localDayOf(chatTimestamp("2026-09-12", 0)), "2026-09-12");
});
