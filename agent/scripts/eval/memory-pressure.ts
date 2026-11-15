// Does a setup fit in this Mac's memory?
//
// While a setup generates, the runner samples `sysctl vm.swapusage` every few
// seconds, and the size of the models Ollama has loaded (`/api/ps`). A model
// that is too big for the Mac pushes memory out to swap, and the replies get
// slow and the Mac gets worse for everything else. The report fails the hard
// check "fits in memory" when swap grew more than the sweep's
// `maxSwapGrowthMB` (512 by default).
//
// One reading covers one generation pass: the model load and the replies of
// one setup for one person. Swap use before the pass is its baseline. Swap
// growth is the highest sample above that baseline. A setup runs once for
// each person, so its readings are saved to a file and combined when the
// report is made: the growth is the worst pass's growth.
//
// Other apps change swap use too, so run a sweep with them closed. The report
// keeps the baseline and the model size, so a close call can be judged by eye.
//
// Both ways of looking (the `sysctl` command and Ollama) are passed in, so the
// tests answer for them.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SwapReading } from "./report.ts";

const BYTES_PER_MB = 1024 * 1024;
const lineBreakPattern = /\r?\n/u;
const usedPattern = /\bused\s*=\s*([\d.,]+)\s*([KMGT]?)/iu;

/** How often a pass is sampled. */
export const SAMPLE_INTERVAL_MS = 3000;

const UNIT_MB: Readonly<Record<string, number>> = {
  "": 1 / BYTES_PER_MB,
  G: 1024,
  K: 1 / 1024,
  M: 1,
  T: 1024 * 1024,
};

/**
 * Swap in use, in MB, from the output of `sysctl vm.swapusage`, such as
 * `vm.swapusage: total = 2048.00M  used = 1031.50M  free = 1016.50M  (encrypted)`.
 * Null when the text has no `used` figure.
 */
export function parseSwapUsedMB(text: string): number | null {
  const match = usedPattern.exec(text);
  if (match === null) {
    return null;
  }
  // A comma beside a period is a thousands mark. A lone comma is a decimal
  // mark, as some locales print it.
  const figure = match[1] ?? "";
  const amount = Number.parseFloat(
    figure.includes(".") ? figure.replaceAll(",", "") : figure.replace(",", ".")
  );
  const scale = UNIT_MB[(match[2] ?? "").toUpperCase()];
  if (!Number.isFinite(amount) || scale === undefined) {
    return null;
  }
  return amount * scale;
}

/** A model Ollama has loaded, with its size in bytes (`/api/ps`). */
export interface LoadedModel {
  name: string;
  size: number;
}

/** What the monitor looks at. The tests answer for both. */
export interface MemoryProbes {
  /** The models Ollama has loaded now. A failure is an empty list. */
  loadedModels: () => Promise<readonly LoadedModel[]>;
  /** The output of `sysctl vm.swapusage`, or null when the command failed. */
  swapUsage: () => Promise<string | null>;
}

/** What one generation pass measured. A figure is null when it could not be read. */
export interface MemoryReading {
  /** Swap in use before the pass, in MB. */
  baselineMB: number | null;
  /** The largest total size of loaded models seen, in MB. */
  modelSizeMB: number | null;
  /** The highest swap in use above the baseline, in MB. Never negative. */
  peakGrowthMB: number | null;
  /** How many times swap was read. */
  samples: number;
}

/** Looks at memory now and then, and remembers the baseline, the peak, and the model size. */
export class MemoryMonitor {
  private baselineMB: number | null = null;
  private peakMB: number | null = null;
  private modelMB: number | null = null;
  private samples = 0;
  private sampling: Promise<void> | null = null;
  private readonly probes: MemoryProbes;

  constructor(probes: MemoryProbes) {
    this.probes = probes;
  }

  /** Takes the baseline. Call it before the pass starts. */
  async begin(): Promise<void> {
    const used = await this.readSwap();
    this.baselineMB = used;
    this.peakMB = used;
    await this.readModels();
  }

  /**
   * Takes one sample. A sample that starts while another is out does not look
   * again. It gives back the one that is out, so awaiting it waits for that
   * sample.
   */
  sample(): Promise<void> {
    if (this.sampling !== null) {
      return this.sampling;
    }
    const run = this.takeSample().finally(() => {
      this.sampling = null;
    });
    this.sampling = run;
    return run;
  }

  /**
   * Takes the last sample. Call it when the pass is done. It waits for a sample
   * that is out, then takes one more, so the last look is after the work and no
   * sample is left out when it returns.
   */
  async finish(): Promise<void> {
    // Only one sample is out at a time, and it clears itself before it settles.
    if (this.sampling !== null) {
      await this.sampling;
    }
    await this.sample();
  }

  private async takeSample(): Promise<void> {
    const used = await this.readSwap();
    if (used !== null) {
      this.peakMB = Math.max(this.peakMB ?? used, used);
      this.baselineMB ??= used;
    }
    await this.readModels();
  }

  /** What was measured so far. */
  reading(): MemoryReading {
    const growth =
      this.baselineMB === null || this.peakMB === null
        ? null
        : Math.max(this.peakMB - this.baselineMB, 0);
    return {
      baselineMB: this.baselineMB,
      modelSizeMB: this.modelMB,
      peakGrowthMB: growth,
      samples: this.samples,
    };
  }

  private async readSwap(): Promise<number | null> {
    let text: string | null;
    try {
      text = await this.probes.swapUsage();
    } catch {
      text = null;
    }
    const used = text === null ? null : parseSwapUsedMB(text);
    if (used !== null) {
      this.samples += 1;
    }
    return used;
  }

  private async readModels(): Promise<void> {
    let models: readonly LoadedModel[];
    try {
      models = await this.probes.loadedModels();
    } catch {
      return;
    }
    const total = models.reduce((sum, model) => sum + model.size, 0);
    if (total > 0) {
      this.modelMB = Math.max(this.modelMB ?? 0, total / BYTES_PER_MB);
    }
  }
}

/**
 * Runs `work` while sampling memory every `intervalMs`: a baseline first, a
 * sample on each tick, and a last sample when the work is done. A sample that
 * is still out when the work ends is waited for first, so the last sample is
 * always a fresh one and none outlives the call. The reading comes back even
 * when the work throws, with the error rethrown after it is saved by
 * `onReading`.
 */
export async function measureMemory<T>(
  probes: MemoryProbes,
  work: () => Promise<T>,
  options: {
    intervalMs?: number;
    onReading?: (reading: MemoryReading) => void;
  } = {}
): Promise<T> {
  const monitor = new MemoryMonitor(probes);
  await monitor.begin();
  const timer = setInterval(() => {
    monitor.sample().catch(() => undefined);
  }, options.intervalMs ?? SAMPLE_INTERVAL_MS);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await monitor.finish();
    options.onReading?.(monitor.reading());
  }
}

// ---------------------------------------------------------------------------
// Saving readings, and combining them for the report
// ---------------------------------------------------------------------------

/** `<runDir>/memory/<setupId>.jsonl`: one line for each pass of the setup. */
export function memoryReadingsPath(runDir: string, setupId: string): string {
  return join(runDir, "memory", `${setupId}.jsonl`);
}

/** Adds the reading of one pass to the setup's file. */
export function appendMemoryReading(
  runDir: string,
  setupId: string,
  person: string,
  reading: MemoryReading
): void {
  const path = memoryReadingsPath(runDir, setupId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ person, ...reading })}\n`, "utf8");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The readings in a setup's file. A line that cannot be read is skipped. */
export function readMemoryReadings(
  runDir: string,
  setupId: string
): MemoryReading[] {
  const path = memoryReadingsPath(runDir, setupId);
  if (!existsSync(path)) {
    return [];
  }
  const readings: MemoryReading[] = [];
  for (const line of readFileSync(path, "utf8").split(lineBreakPattern)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      readings.push({
        baselineMB: numberOrNull(parsed.baselineMB),
        modelSizeMB: numberOrNull(parsed.modelSizeMB),
        peakGrowthMB: numberOrNull(parsed.peakGrowthMB),
        samples: numberOrNull(parsed.samples) ?? 0,
      });
    } catch {
      // A half-written line from a run that was stopped says nothing.
    }
  }
  return readings;
}

/**
 * One setup's swap reading for the report, from its passes. The growth is the
 * worst pass's growth, and the baseline is that pass's baseline, so the two
 * belong together. The model size is the largest seen. With no pass that could
 * read swap, the growth is null and the hard check is not judged.
 */
export function combineReadings(
  readings: readonly MemoryReading[]
): SwapReading | undefined {
  if (readings.length === 0) {
    return undefined;
  }
  let worst: MemoryReading | undefined;
  for (const reading of readings) {
    if (
      reading.peakGrowthMB !== null &&
      (worst === undefined ||
        reading.peakGrowthMB > (worst.peakGrowthMB ?? Number.NEGATIVE_INFINITY))
    ) {
      worst = reading;
    }
  }
  const sizes = readings.flatMap((reading) =>
    reading.modelSizeMB === null ? [] : [reading.modelSizeMB]
  );
  return {
    modelSizeMB: sizes.length === 0 ? null : Math.max(...sizes),
    swapBaselineMB: worst?.baselineMB ?? null,
    swapGrowthMB: worst?.peakGrowthMB ?? null,
  };
}

/** The swap reading of a setup, from the file its passes wrote. */
export function readSwapReading(
  runDir: string,
  setupId: string
): SwapReading | undefined {
  return combineReadings(readMemoryReadings(runDir, setupId));
}
