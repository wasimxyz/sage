import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import test from "node:test";

import { parseSweepFile } from "../../evals/lib/schema.ts";
import {
  appendMemoryReading,
  combineReadings,
  type LoadedModel,
  MemoryMonitor,
  type MemoryProbes,
  type MemoryReading,
  measureMemory,
  memoryReadingsPath,
  parseSwapUsedMB,
  readMemoryReadings,
  readSwapReading,
} from "./memory-pressure.ts";
import { summarize } from "./report.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern2 = /the pass crashed/u;
const pattern1 = /swap grew 513 MB, over the 512 MB limit/u;

const GB = 1024 ** 3;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function swapText(usedMB: number): string {
  return `vm.swapusage: total = 4096.00M  used = ${usedMB.toFixed(2)}M  free = ${(4096 - usedMB).toFixed(2)}M  (encrypted)\n`;
}

/** Probes that answer from lists, one answer for each look. The last one repeats. */
function scripted(options: {
  models?: LoadedModel[][];
  swap?: (string | null | Error)[];
}): MemoryProbes & { looks: { models: number; swap: number } } {
  const looks = { models: 0, swap: 0 };
  const pick = <T>(list: T[], index: number): T =>
    list[Math.min(index, list.length - 1)] as T;
  return {
    loadedModels: () => {
      const answer = pick(options.models ?? [[]], looks.models);
      looks.models += 1;
      return Promise.resolve(answer);
    },
    looks,
    swapUsage: () => {
      const answer = pick(options.swap ?? [null], looks.swap);
      looks.swap += 1;
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing sysctl
// ---------------------------------------------------------------------------

test("parseSwapUsedMB reads the used figure from sysctl vm.swapusage", () => {
  assert.equal(
    parseSwapUsedMB(
      "vm.swapusage: total = 2048.00M  used = 1031.50M  free = 1016.50M  (encrypted)"
    ),
    1031.5
  );
  assert.equal(parseSwapUsedMB(swapText(0)), 0);
});

test("parseSwapUsedMB reads other units", () => {
  assert.equal(
    parseSwapUsedMB("vm.swapusage: total = 4.00G  used = 1.50G  free = 2.50G"),
    1536
  );
  assert.equal(
    parseSwapUsedMB("total = 1.00G  used = 512.00K  free = 1.00G"),
    0.5
  );
  assert.equal(
    parseSwapUsedMB("total = 2,048.00M  used = 1,024.00M  free = 1,024.00M"),
    1024
  );
  assert.equal(
    parseSwapUsedMB("total = 2048,00M  used = 1031,50M  free = 1016,50M"),
    1031.5
  );
});

test("parseSwapUsedMB gives null when there is no used figure", () => {
  for (const text of [
    "",
    "sysctl: unknown oid 'vm.swapusage'",
    "vm.swapusage: total = 2048.00M",
    "used = lots",
  ]) {
    assert.equal(parseSwapUsedMB(text), null, text);
  }
});

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

test("the baseline is swap use before the pass, the growth is the peak above it, and the model size is the largest seen", async () => {
  const probes = scripted({
    models: [[], [{ name: "a", size: 6 * GB }], [{ name: "a", size: 5 * GB }]],
    swap: [swapText(100), swapText(250), swapText(900), swapText(300)],
  });
  const monitor = new MemoryMonitor(probes);
  await monitor.begin();
  await monitor.sample();
  await monitor.sample();
  await monitor.sample();
  const reading = monitor.reading();
  assert.equal(reading.baselineMB, 100);
  assert.equal(reading.peakGrowthMB, 800);
  assert.equal(reading.modelSizeMB, 6 * 1024);
  assert.equal(reading.samples, 4);
});

test("loaded models are added up, and a pass with none loaded has no model size", async () => {
  const two = new MemoryMonitor(
    scripted({
      models: [
        [
          { name: "chat", size: 5 * GB },
          { name: "embed", size: 0.5 * GB },
        ],
      ],
      swap: [swapText(0)],
    })
  );
  await two.begin();
  assert.equal(two.reading().modelSizeMB, 5.5 * 1024);
  const none = new MemoryMonitor(scripted({ swap: [swapText(0)] }));
  await none.begin();
  assert.equal(none.reading().modelSizeMB, null);
});

test("swap that falls below the baseline is no growth, never a negative one", async () => {
  const monitor = new MemoryMonitor(
    scripted({ swap: [swapText(800), swapText(200)] })
  );
  await monitor.begin();
  await monitor.sample();
  assert.equal(monitor.reading().peakGrowthMB, 0);
});

test("a sysctl that fails, throws, or prints nonsense leaves the figures null instead of failing the pass", async () => {
  const answers = [null, new Error("no sysctl"), "garbage"];
  await Promise.all(
    answers.map(async (answer) => {
      const monitor = new MemoryMonitor(
        scripted({ models: [[{ name: "a", size: GB }]], swap: [answer] })
      );
      await monitor.begin();
      await monitor.sample();
      const taken = monitor.reading();
      assert.equal(taken.baselineMB, null, String(answer));
      assert.equal(taken.peakGrowthMB, null, String(answer));
      assert.equal(taken.samples, 0);
      assert.equal(taken.modelSizeMB, 1024);
    })
  );
});

test("a baseline that could not be read is taken from the first sample that can", async () => {
  const monitor = new MemoryMonitor(
    scripted({ swap: [null, swapText(300), swapText(700)] })
  );
  await monitor.begin();
  await monitor.sample();
  await monitor.sample();
  const reading = monitor.reading();
  assert.equal(reading.baselineMB, 300);
  assert.equal(reading.peakGrowthMB, 400);
});

test("a sample that starts while another is still out does not look again, and waits for the one that is out", async () => {
  let release: () => void = () => undefined;
  let calls = 0;
  const monitor = new MemoryMonitor({
    loadedModels: () => Promise.resolve([]),
    swapUsage: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(swapText(0));
      }
      return new Promise<string>((resolve) => {
        release = () => resolve(swapText(50));
      });
    },
  });
  await monitor.begin();
  const first = monitor.sample();
  const second = monitor.sample();
  assert.equal(calls, 2, "the second sample did not look");
  assert.equal(second, first, "the second sample is the one that is out");
  const outcome = await Promise.race([
    second.then(() => "done"),
    sleep(5).then(() => "waiting"),
  ]);
  assert.equal(outcome, "waiting", "the second sample did not wait");
  release();
  await second;
  assert.equal(monitor.reading().peakGrowthMB, 50);
});

test("finish waits for a sample that is out, then looks once more", async () => {
  let release: () => void = () => undefined;
  let calls = 0;
  const monitor = new MemoryMonitor({
    loadedModels: () => Promise.resolve([]),
    swapUsage: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(swapText(100));
      }
      if (calls === 2) {
        return new Promise<string>((resolve) => {
          release = () => resolve(swapText(300));
        });
      }
      return Promise.resolve(swapText(900));
    },
  });
  await monitor.begin();
  monitor.sample().catch(() => undefined);
  const finished = monitor.finish();
  await sleep(5);
  assert.equal(calls, 2, "finish looked while a sample was still out");
  release();
  await finished;
  assert.equal(calls, 3, "finish took no fresh sample");
  assert.equal(monitor.reading().peakGrowthMB, 800);
  await monitor.finish();
  assert.equal(calls, 4, "finish with nothing out takes one sample");
});

// ---------------------------------------------------------------------------
// Sampling while work runs
// ---------------------------------------------------------------------------

test("measureMemory samples while the work runs and again when it ends, and hands the reading on", async () => {
  const probes = scripted({
    swap: [swapText(100), swapText(100), swapText(700), swapText(700)],
  });
  const readings: MemoryReading[] = [];
  const value = await measureMemory(
    probes,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    },
    { intervalMs: 10, onReading: (taken) => readings.push(taken) }
  );
  assert.equal(value, "done");
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.baselineMB, 100);
  assert.equal(readings[0]?.peakGrowthMB, 600);
  assert.ok(probes.looks.swap >= 3, `${probes.looks.swap} looks at swap`);
});

test("measureMemory waits for a sample that is still out when the work ends, then takes a fresh last one", async () => {
  // Swap is 100 MB before the pass and 900 MB from then on. The first tick's
  // look at swap is slow (a slow sysctl, or /api/ps waiting on a busy Ollama),
  // and it is still out when the 40 ms of work end.
  let looks = 0;
  const probes: MemoryProbes = {
    loadedModels: () => Promise.resolve([]),
    swapUsage: () => {
      looks += 1;
      if (looks === 1) {
        return Promise.resolve(swapText(100));
      }
      if (looks === 2) {
        return sleep(60).then(() => swapText(900));
      }
      return Promise.resolve(swapText(900));
    },
  };
  const readings: MemoryReading[] = [];
  await measureMemory(probes, () => sleep(40), {
    intervalMs: 10,
    onReading: (taken) => readings.push(taken),
  });
  // The slow look came back first, then the last sample looked once more.
  assert.equal(looks, 3, "the last sample did not look at swap");
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.peakGrowthMB, 800);
  assert.equal(readings[0]?.samples, 3);
  // No sample outlives the call.
  await sleep(30);
  assert.equal(looks, 3, "a sample was still going after measureMemory");
});

test("measureMemory saves the reading when the work throws, and rethrows", async () => {
  const readings: MemoryReading[] = [];
  await assert.rejects(
    measureMemory(
      scripted({ swap: [swapText(10), swapText(30)] }),
      () => Promise.reject(new Error("the pass crashed")),
      { intervalMs: 1000, onReading: (taken) => readings.push(taken) }
    ),
    pattern2
  );
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.peakGrowthMB, 20);
});

// ---------------------------------------------------------------------------
// Readings in a file, and the hard check
// ---------------------------------------------------------------------------

const reading = (
  baselineMB: number | null,
  peakGrowthMB: number | null,
  modelSizeMB: number | null = null
): MemoryReading => ({ baselineMB, modelSizeMB, peakGrowthMB, samples: 3 });

test("combineReadings takes the worst pass's growth with its own baseline, and the largest model", () => {
  assert.deepEqual(
    combineReadings([
      reading(100, 50, 4000),
      reading(300, 700, 6000),
      reading(200, 20, 5000),
    ]),
    { modelSizeMB: 6000, swapBaselineMB: 300, swapGrowthMB: 700 }
  );
});

test("combineReadings leaves growth null when no pass could read swap, and gives nothing for no passes", () => {
  assert.deepEqual(combineReadings([reading(null, null, 4000)]), {
    modelSizeMB: 4000,
    swapBaselineMB: null,
    swapGrowthMB: null,
  });
  assert.equal(combineReadings([]), undefined);
  assert.deepEqual(combineReadings([reading(null, null), reading(10, 0)]), {
    modelSizeMB: null,
    swapBaselineMB: 10,
    swapGrowthMB: 0,
  });
});

test("readings are kept one line for each pass, and read back for the setup", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readMemoryReadings(dir, "abc"), []);
  assert.equal(readSwapReading(dir, "abc"), undefined);
  appendMemoryReading(dir, "abc", "sam", reading(100, 600, 5000));
  appendMemoryReading(dir, "abc", "grief", reading(150, 40, 5000));
  appendMemoryReading(dir, "other", "sam", reading(0, 9999));
  assert.equal(readMemoryReadings(dir, "abc").length, 2);
  assert.deepEqual(readSwapReading(dir, "abc"), {
    modelSizeMB: 5000,
    swapBaselineMB: 100,
    swapGrowthMB: 600,
  });
});

test("a half-written or damaged line is skipped", (t) => {
  const dir = tempDir(t);
  appendMemoryReading(dir, "abc", "sam", reading(100, 600));
  appendFileSync(memoryReadingsPath(dir, "abc"), '{"baselineMB": 1, "peak\n');
  appendFileSync(
    memoryReadingsPath(dir, "abc"),
    '{"baselineMB":"x","peakGrowthMB":null}\n'
  );
  const readings = readMemoryReadings(dir, "abc");
  assert.equal(readings.length, 2);
  assert.equal(readings[0]?.peakGrowthMB, 600);
  assert.equal(readings[1]?.baselineMB, null);
});

test("fits-in-memory fails the setup when swap grew past maxSwapGrowthMB, and not at or under it", (t) => {
  const dir = tempDir(t);
  const sweep = parseSweepFile({ maxSwapGrowthMB: 512 });
  const summaryFor = (growth: number | null) => {
    appendMemoryReading(dir, `s${growth}`, "sam", reading(100, growth));
    return summarize([], [], sweep, {
      costUsd: 0,
      swap: readSwapReading(dir, `s${growth}`),
    });
  };
  const over = summaryFor(513);
  assert.deepEqual(
    over.hardFailures.map((failure) => failure.id),
    ["fits-in-memory"]
  );
  assert.match(over.hardFailures[0]?.detail ?? "", pattern1);
  assert.equal(over.swapGrowthMB, 513);
  assert.equal(over.swapBaselineMB, 100);
  assert.deepEqual(summaryFor(512).hardFailures, []);
  assert.deepEqual(summaryFor(0).hardFailures, []);
  // A swap that could not be read is not judged, and is not a failure.
  const unread = summaryFor(null);
  assert.deepEqual(unread.hardFailures, []);
  assert.equal(unread.swapGrowthMB, null);
});

test("the sweep's limit is the one that counts", (t) => {
  const dir = tempDir(t);
  appendMemoryReading(dir, "x", "sam", reading(0, 300, 7000));
  const swap = readSwapReading(dir, "x");
  const strict = summarize([], [], parseSweepFile({ maxSwapGrowthMB: 256 }), {
    costUsd: 0,
    swap,
  });
  const loose = summarize([], [], parseSweepFile({ maxSwapGrowthMB: 1024 }), {
    costUsd: 0,
    swap,
  });
  assert.equal(strict.hardFailures.length, 1);
  assert.equal(loose.hardFailures.length, 0);
  assert.equal(loose.modelSizeMB, 7000);
});
