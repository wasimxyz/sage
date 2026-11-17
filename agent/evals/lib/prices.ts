/**
 * Prices for the cloud models the eval suite calls, read from the public
 * Vercel AI Gateway catalog. No credentials are needed, so the runner can
 * estimate a sweep before it holds a key.
 *
 * - `GET /v1/models` lists every model with its price per token.
 * - `GET /v1/models/<id>/endpoints` lists the providers behind one model, each
 *   with its own price and, for some, a peak-hours multiplier.
 *
 * Prices go in as USD per token (strings) and come out as USD per million
 * tokens. When a price has tiers, the most expensive tier is used, so an
 * estimate never comes out low.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ModelPrice {
  cachedInputPerM?: number;
  inputPerM: number;
  outputPerM: number;
}

export interface TokenUsage {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
const PER_MILLION = 1_000_000;
const CLEAN_DIGITS = 12;
const FETCH_TIMEOUT_MS = 20_000;
/** A cached price older than this is read again. Prices rarely move within an hour. */
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
/** Prices within this much of the limit still count as under it (float noise). */
const PRICE_SLACK = 1e-9;
const CACHE_VERSION = 1;
const CHARS_PER_TOKEN = 4;

interface CacheEntry {
  fetchedAt: string;
  price: ModelPrice;
}

interface CacheFile {
  models: Record<string, CacheEntry>;
  version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** USD per token as text or a number, to USD per million tokens. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) {
    return undefined;
  }
  return Number((perToken * PER_MILLION).toPrecision(CLEAN_DIGITS));
}

/** The base price, or the most expensive tier when the price has tiers. */
function topPrice(
  pricing: Record<string, unknown>,
  key: string,
  tiersKey: string
): number | undefined {
  const values: number[] = [];
  const base = perMillion(pricing[key]);
  if (base !== undefined) {
    values.push(base);
  }
  const tiers = pricing[tiersKey];
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      const cost = isRecord(tier) ? perMillion(tier.cost) : undefined;
      if (cost !== undefined) {
        values.push(cost);
      }
    }
  }
  return values.length === 0 ? undefined : Math.max(...values);
}

function priceFrom(pricing: unknown): ModelPrice | undefined {
  if (!isRecord(pricing)) {
    return undefined;
  }
  const inputPerM = topPrice(pricing, "input", "input_tiers");
  const outputPerM = topPrice(pricing, "output", "output_tiers");
  if (inputPerM === undefined || outputPerM === undefined) {
    return undefined;
  }
  const cachedInputPerM = topPrice(
    pricing,
    "input_cache_read",
    "input_cache_read_tiers"
  );
  return cachedInputPerM === undefined
    ? { inputPerM, outputPerM }
    : { cachedInputPerM, inputPerM, outputPerM };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}.`);
  }
  return await response.json();
}

function isPrice(value: unknown): value is ModelPrice {
  return (
    isRecord(value) &&
    typeof value.inputPerM === "number" &&
    typeof value.outputPerM === "number" &&
    (value.cachedInputPerM === undefined ||
      typeof value.cachedInputPerM === "number")
  );
}

function readCache(path: string | undefined): CacheFile {
  const empty: CacheFile = { models: {}, version: CACHE_VERSION };
  if (path === undefined) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or damaged: read the prices again.
    return empty;
  }
  if (!(isRecord(parsed) && isRecord(parsed.models))) {
    return empty;
  }
  const models: Record<string, CacheEntry> = {};
  for (const [id, entry] of Object.entries(parsed.models)) {
    if (
      isRecord(entry) &&
      typeof entry.fetchedAt === "string" &&
      isPrice(entry.price)
    ) {
      models[id] = { fetchedAt: entry.fetchedAt, price: entry.price };
    }
  }
  return { models, version: CACHE_VERSION };
}

function writeCache(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write beside the file and rename, so a reader never sees half a file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function isFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (entry === undefined) {
    return false;
  }
  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_MAX_AGE_MS;
}

function pickPrices(
  models: readonly string[],
  cache: CacheFile
): Record<string, ModelPrice> {
  const picked: Record<string, ModelPrice> = {};
  for (const id of models) {
    const entry = cache.models[id];
    if (entry !== undefined) {
      picked[id] = entry.price;
    }
  }
  return picked;
}

/**
 * The price cache of one sweep: `prices.json` in its run folder. The runner
 * reads prices for its estimate into this file, and the grade processes, which
 * get the same run folder, reuse that read.
 */
export function priceCacheFile(runDir: string): string {
  return join(runDir, "prices.json");
}

/**
 * Prices in USD per million tokens, keyed by gateway model id such as
 * `moonshotai/kimi-k3.1-pro`.
 *
 * With `cacheFile`, prices are saved there and reused for an hour, so the
 * eval processes of one sweep share one read. If the catalog cannot be read
 * but the cache has every model, the cached prices are used, however old.
 * Throws when a model has no price.
 */
export async function loadPrices(
  models: string[],
  opts: { cacheFile?: string } = {}
): Promise<Record<string, ModelPrice>> {
  const wanted = [...new Set(models)];
  const now = Date.now();
  const cache = readCache(opts.cacheFile);
  if (wanted.every((id) => isFresh(cache.models[id], now))) {
    return pickPrices(wanted, cache);
  }

  let catalog: unknown;
  try {
    catalog = await fetchJson(`${GATEWAY_ORIGIN}/v1/models`);
  } catch (error) {
    if (wanted.every((id) => cache.models[id] !== undefined)) {
      return pickPrices(wanted, cache);
    }
    throw new Error(
      `Could not read prices from the AI Gateway: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const rows =
    isRecord(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
  const fetchedAt = new Date(now).toISOString();
  const missing: string[] = [];
  for (const id of wanted) {
    const row = rows.find((item) => isRecord(item) && item.id === id);
    const price = isRecord(row) ? priceFrom(row.pricing) : undefined;
    if (price === undefined) {
      missing.push(id);
    } else {
      cache.models[id] = { fetchedAt, price };
    }
  }
  if (missing.length > 0) {
    throw new Error(`The AI Gateway has no price for: ${missing.join(", ")}.`);
  }
  if (opts.cacheFile !== undefined) {
    writeCache(opts.cacheFile, cache);
  }
  return pickPrices(wanted, cache);
}

/** The peak-hours multiplier of an endpoint, 1 when it has none. */
function peakMultiplier(pricing: Record<string, unknown>): number {
  const peak = pricing.peak_pricing;
  if (!isRecord(peak)) {
    return 1;
  }
  const multiplier = Number(peak.multiplier);
  return Number.isFinite(multiplier) && multiplier > 1 ? multiplier : 1;
}

/** Output price of one endpoint at its worst hour, in USD per million tokens. */
function worstOutputPerM(endpoint: unknown): number | undefined {
  if (!(isRecord(endpoint) && isRecord(endpoint.pricing))) {
    return undefined;
  }
  const outputPerM = perMillion(endpoint.pricing.completion);
  if (outputPerM === undefined) {
    return undefined;
  }
  return Number(
    (outputPerM * peakMultiplier(endpoint.pricing)).toPrecision(CLEAN_DIGITS)
  );
}

/**
 * The providers that serve `model` for at most `maxOutputPricePerM` dollars
 * per million output tokens, cheapest first. A provider with peak-hours
 * pricing counts at its peak price, so one that doubles at peak hours is left
 * out when double its price is over the limit.
 *
 * `maxOutputPerM` is the dearest output price among the providers returned,
 * the price a spending estimate should use for requests routed to them.
 * Throws when no provider qualifies, because an empty list would let the
 * gateway route anywhere.
 */
export async function allowedProviders(
  model: string,
  maxOutputPricePerM: number
): Promise<{ maxOutputPerM: number; providers: string[] }> {
  const path = model.split("/").map(encodeURIComponent).join("/");
  let payload: unknown;
  try {
    payload = await fetchJson(`${GATEWAY_ORIGIN}/v1/models/${path}/endpoints`);
  } catch (error) {
    throw new Error(
      `Could not read the providers of ${model}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  const data = isRecord(payload) ? payload.data : undefined;
  const endpoints =
    isRecord(data) && Array.isArray(data.endpoints) ? data.endpoints : [];

  const byProvider = new Map<string, number>();
  for (const endpoint of endpoints) {
    const outputPerM = worstOutputPerM(endpoint);
    const name =
      isRecord(endpoint) && typeof endpoint.provider_name === "string"
        ? endpoint.provider_name
        : undefined;
    if (
      outputPerM === undefined ||
      name === undefined ||
      outputPerM > maxOutputPricePerM + PRICE_SLACK
    ) {
      continue;
    }
    // A provider listed twice counts at its dearest endpoint.
    byProvider.set(name, Math.max(byProvider.get(name) ?? 0, outputPerM));
  }
  if (byProvider.size === 0) {
    throw new Error(
      `No provider serves ${model} for $${maxOutputPricePerM} per million output tokens or less.`
    );
  }
  const sorted = [...byProvider.entries()].sort(
    ([nameA, priceA], [nameB, priceB]) =>
      priceA - priceB || (nameA < nameB ? -1 : 1)
  );
  return {
    maxOutputPerM: Math.max(...sorted.map(([, price]) => price)),
    providers: sorted.map(([name]) => name),
  };
}

/**
 * The cost of one call in USD. `inputTokens` is the whole prompt, cached
 * tokens included. Cached tokens are billed at `cachedInputPerM` when the
 * model has one, else at the input price.
 */
export function costUsd(price: ModelPrice, usage: TokenUsage): number {
  const cached = Math.min(
    Math.max(usage.cachedInputTokens ?? 0, 0),
    usage.inputTokens
  );
  const fresh = Math.max(usage.inputTokens - cached, 0);
  return (
    (fresh * price.inputPerM +
      cached * (price.cachedInputPerM ?? price.inputPerM) +
      Math.max(usage.outputTokens, 0) * price.outputPerM) /
    PER_MILLION
  );
}

/**
 * The most a call can cost: the prompt at about four characters a token, all
 * at the full input price, plus every output token the cap allows.
 */
export function estimateUsd(
  price: ModelPrice,
  call: { maxOutputTokens: number; promptChars: number }
): number {
  return (
    ((call.promptChars / CHARS_PER_TOKEN) * price.inputPerM +
      call.maxOutputTokens * price.outputPerM) /
    PER_MILLION
  );
}
