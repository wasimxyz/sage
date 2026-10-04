/**
 * Refreshes `src/lib/canirun-catalog.json`, the committed canirun.ai snapshot
 * that the Models table reads. The running app never calls canirun.ai, so run
 * this by hand when the model list or the grades need a refresh:
 *
 *   node --experimental-strip-types scripts/fetch-canirun-catalog.ts
 *
 * It reads the catalog, keeps the models that carry an Ollama tag, and asks
 * canirun to grade each of those for every Mac profile below at Q4_K_M.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const origin = "https://www.canirun.ai";
const quantization = "Q4_K_M";
const requestPoolSize = 4;
const requestDelayMs = 200;
const rateLimitPauseMs = 3000;
const fetchAttempts = 5;
const outputPath = fileURLToPath(
  new URL("../src/lib/canirun-catalog.json", import.meta.url)
);

/**
 * `machdep.cpu.brand_string` values and the unified memory sizes those Macs
 * ship with, from Apple's current chip and machine pages. Ultra-class names
 * carry the Mac Studio sizes. No Mac ships `Apple M4 Ultra` yet; canirun
 * grades that name like a base M4, and the numbers stay whatever it returns.
 *
 * Keep this a list: the order sets the `profiles` order in the snapshot, and
 * the formatter sorts object keys.
 */
const macProfiles: [string, number[]][] = [
  ["Apple M1", [8, 16]],
  ["Apple M1 Pro", [16, 32]],
  ["Apple M1 Max", [32, 64]],
  ["Apple M1 Ultra", [64, 128]],
  ["Apple M2", [8, 16, 24]],
  ["Apple M2 Pro", [16, 32]],
  ["Apple M2 Max", [32, 64, 96]],
  ["Apple M2 Ultra", [64, 128, 192]],
  ["Apple M3", [8, 16, 24]],
  ["Apple M3 Pro", [18, 36]],
  // 96 GB is the 14-core MacBook Pro. Leaving it out grades that Mac as 64 GB.
  ["Apple M3 Max", [36, 48, 64, 96, 128]],
  ["Apple M3 Ultra", [96, 256, 512]],
  ["Apple M4", [16, 24, 32]],
  ["Apple M4 Pro", [24, 48, 64]],
  ["Apple M4 Max", [36, 48, 64, 128]],
  ["Apple M4 Ultra", [96, 256, 512]],
  ["Apple M5", [16, 24, 32]],
  ["Apple M5 Pro", [24, 48, 64]],
  ["Apple M5 Max", [36, 48, 64, 128]],
  ["Apple M5 Ultra", [96, 256, 512]],
  ["Apple M6", [16, 24, 32]],
];

interface ModelSummary {
  id: string;
  name: string;
  paramsBillions: number;
  useCase: string[];
}

interface ModelDetail {
  id: string;
  name: string;
  ollamaId: string | null;
  paramsBillions: number;
  q4DiskGb: number;
  q4VramGb: number;
  recommendedRamGb: number;
  useCase: string[];
}

interface CatalogGrade {
  compatible: boolean;
  diskSizeGb: number;
  score: number;
  tokensPerSecond: number;
  vramGb: number;
}

interface CatalogModel extends Omit<ModelDetail, "ollamaId"> {
  grades: Record<string, CatalogGrade>;
  ollamaId: string;
}

interface CatalogFile {
  fetchedAt: string;
  models: CatalogModel[];
  profiles: string[];
  quantization: string;
  source: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelayMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  let lastError: Error = new Error(`Could not read ${url}`);
  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: attempts must wait between tries
    await sleep(attempt === 1 ? requestDelayMs : retryDelayMs(attempt));
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`${url} responded ${response.status}`);
      if (response.status < 500 && response.status !== 429) {
        break;
      }
      if (response.status === 429) {
        await sleep(rateLimitPauseMs * attempt);
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSummary(value: unknown): ModelSummary | null {
  const item = asRecord(value);
  if (!(item && typeof item.id === "string" && typeof item.name === "string")) {
    return null;
  }
  const useCase = Array.isArray(item.useCase)
    ? item.useCase.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: item.id,
    name: item.name,
    paramsBillions: asFiniteNumber(item.paramsBillions, 0),
    useCase,
  };
}

function parseDetail(value: unknown): ModelDetail | null {
  const item = asRecord(value);
  if (!(item && typeof item.id === "string" && typeof item.name === "string")) {
    return null;
  }
  const ollamaId =
    typeof item.ollamaId === "string" ? item.ollamaId.trim() : "";
  if (ollamaId.length === 0) {
    return null;
  }
  const quants = Array.isArray(item.quants) ? item.quants : [];
  const quant = quants
    .map((entry) => asRecord(entry))
    .find((entry) => entry?.name === quantization);
  if (!quant) {
    return null;
  }
  const useCase = Array.isArray(item.useCase)
    ? item.useCase.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: item.id,
    name: item.name,
    ollamaId,
    paramsBillions: asFiniteNumber(item.paramsBillions, 0),
    q4DiskGb: asFiniteNumber(quant.diskGB, 0),
    q4VramGb: asFiniteNumber(quant.vramGB, 0),
    recommendedRamGb: asFiniteNumber(item.recommendedRamGB, 0),
    useCase,
  };
}

function parseGrade(value: unknown): CatalogGrade | null {
  const item = asRecord(value);
  if (!item) {
    return null;
  }
  const estimated = asRecord(item.estimated) ?? {};
  return {
    compatible: item.compatible === true,
    diskSizeGb: asFiniteNumber(estimated.modelSizeGb, 0),
    score: asFiniteNumber(item.score, 0),
    tokensPerSecond: asFiniteNumber(estimated.tokensPerSecond, 0),
    vramGb: asFiniteNumber(estimated.vramRequiredGb, 0),
  };
}

async function grade(
  model: ModelDetail,
  chipName: string,
  ramGb: number
): Promise<CatalogGrade | null> {
  const body = JSON.stringify({
    hardware: {
      appleSilicon: true,
      cpu: { name: chipName },
      gpu: { name: chipName },
      platform: "macOS",
      ramGb,
    },
    modelId: model.id,
    quantization,
  });
  const value = await readJson(`${origin}/api/compatibility`, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parseGrade(value);
}

async function mapPool<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(requestPoolSize, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        // biome-ignore lint/performance/noAwaitInLoops: workers pull the next item as they finish
        out[index] = await mapper(item, index);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

async function fetchModels(): Promise<ModelDetail[]> {
  const listValue = await readJson(`${origin}/api/models`);
  const listRecord = asRecord(listValue);
  const list = Array.isArray(listRecord?.models) ? listRecord.models : [];
  const summaries = list
    .map((entry) => parseSummary(entry))
    .filter((entry): entry is ModelSummary => entry !== null);
  process.stdout.write(
    `Read ${summaries.length} models. Fetching details for each.\n`
  );
  const details = await mapPool(summaries, async (summary) =>
    parseDetail(await readJson(`${origin}/api/models/${summary.id}`))
  );
  const withOllamaTag = details.filter(
    (detail): detail is ModelDetail => detail !== null
  );
  process.stdout.write(
    `${withOllamaTag.length} of ${summaries.length} models have a ${quantization} size and an Ollama tag.\n`
  );
  return withOllamaTag.sort((a, b) => a.id.localeCompare(b.id));
}

async function buildCatalog(): Promise<CatalogFile> {
  const models = await fetchModels();
  const profiles: string[] = [];
  for (const [chipName, ramSizes] of macProfiles) {
    for (const ramGb of ramSizes) {
      profiles.push(`${chipName}|${ramGb}`);
    }
  }
  process.stdout.write(
    `Grading ${models.length} models for ${profiles.length} Mac profiles.\n`
  );
  const gradesByModel = new Map<string, Record<string, CatalogGrade>>();
  for (const model of models) {
    gradesByModel.set(model.id, {});
  }
  let done = 0;
  await mapPool(
    models.flatMap((model) => profiles.map((profile) => ({ model, profile }))),
    async ({ model, profile }) => {
      const [chip, ramGb] = profile.split("|");
      if (!(chip && ramGb)) {
        throw new Error(`Unreadable profile: ${profile}`);
      }
      const modelGrades = gradesByModel.get(model.id);
      if (!modelGrades) {
        throw new Error(`No grade table for ${model.id}`);
      }
      const parsed = await grade(model, chip, Number(ramGb));
      if (parsed) {
        modelGrades[profile] = parsed;
      }
      done += 1;
      if (done % 200 === 0) {
        process.stdout.write(`  ${done} grades\n`);
      }
    }
  );
  const catalog: CatalogFile = {
    fetchedAt: new Date().toISOString().slice(0, 10),
    models: models.map((model) => ({
      ...model,
      grades: orderedGrades(gradesByModel.get(model.id), profiles, model.id),
      ollamaId: model.ollamaId ?? "",
    })),
    profiles,
    quantization,
    source: origin,
  };
  return catalog;
}

/** Profile order, so a refresh only changes the numbers that moved. */
function orderedGrades(
  grades: Record<string, CatalogGrade> | undefined,
  profiles: readonly string[],
  modelId: string
): Record<string, CatalogGrade> {
  const ordered: Record<string, CatalogGrade> = {};
  for (const profile of profiles) {
    const entry = grades?.[profile];
    if (!entry) {
      throw new Error(`${modelId} is missing a grade for ${profile}.`);
    }
    ordered[profile] = entry;
  }
  return ordered;
}

/** Drop the date, so a refresh can tell whether any grade moved. */
function catalogData(file: CatalogFile): string {
  return JSON.stringify({
    models: file.models,
    profiles: file.profiles,
    quantization: file.quantization,
    source: file.source,
  });
}

const catalog = await buildCatalog();
let previous: CatalogFile | null = null;
try {
  previous = JSON.parse(await readFile(outputPath, "utf8")) as CatalogFile;
} catch {
  previous = null;
}
if (previous && catalogData(previous) === catalogData(catalog)) {
  process.stdout.write(
    "Grades are unchanged. Left the catalog file as it is.\n"
  );
} else {
  await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${catalog.models.length} models and ${catalog.profiles.length} profiles to ${outputPath}\n`
  );
}
