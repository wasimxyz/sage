// The runner's view of the cloud pieces the judge owns:
//
//   agent/evals/lib/prices.ts   loadPrices(models, opts?)
//   agent/evals/lib/ledger.ts   totals(runDir)
//
// Both are found at run time. When one is missing (an older checkout) or a
// call fails (no network), the runner falls back: the estimate uses the
// default prices below, and spending shows as unknown.

export interface ModelPrice {
  cachedInputPerM?: number;
  inputPerM: number;
  outputPerM: number;
}

export interface LedgerTotals {
  byModel: Record<string, { calls: number; spentUsd: number }>;
  calls: number;
  reservedUsd: number;
  spentUsd: number;
}

interface PricesModule {
  loadPrices(
    models: string[],
    opts?: { cacheFile?: string }
  ): Promise<Record<string, ModelPrice>>;
}

interface LedgerModule {
  totals(runDir: string): LedgerTotals;
}

/** Used when the gateway's price list cannot be read. Per million tokens. */
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 2, outputPerM: 10 };
export const DEFAULT_SIMULATED_USER_PRICE: ModelPrice = {
  inputPerM: 0.14,
  outputPerM: 0.5,
};

const pricesUrl = new URL("../../evals/lib/prices.ts", import.meta.url);
const ledgerUrl = new URL("../../evals/lib/ledger.ts", import.meta.url);

async function importOptional<T>(url: URL, names: string[]): Promise<T | null> {
  try {
    const loaded = (await import(url.href)) as Record<string, unknown>;
    return names.every((name) => typeof loaded[name] === "function")
      ? (loaded as unknown as T)
      : null;
  } catch {
    return null;
  }
}

export interface PriceBook {
  /** True when a price is the built-in default, not the gateway's. */
  defaulted: string[];
  prices: Record<string, ModelPrice>;
}

/**
 * Prices for the given models. A model the gateway does not list, or any
 * failure, gets the default price for its role and is named in `defaulted`.
 */
export async function loadPriceBook(
  models: { fallback: ModelPrice; id: string }[]
): Promise<PriceBook> {
  const prices: Record<string, ModelPrice> = {};
  const defaulted: string[] = [];
  let loaded: Record<string, ModelPrice> = {};
  const module = await importOptional<PricesModule>(pricesUrl, ["loadPrices"]);
  if (module !== null) {
    try {
      loaded = await module.loadPrices(models.map((model) => model.id));
    } catch {
      loaded = {};
    }
  }
  for (const model of models) {
    const price = loaded[model.id];
    if (price === undefined) {
      prices[model.id] = model.fallback;
      defaulted.push(model.id);
    } else {
      prices[model.id] = price;
    }
  }
  return { defaulted, prices };
}

/** Reads the sweep's spending so far. Null when the ledger does not exist yet. */
export async function ledgerReader(
  runDir: string
): Promise<(() => number) | null> {
  const module = await importOptional<LedgerModule>(ledgerUrl, ["totals"]);
  if (module === null) {
    return null;
  }
  return () => {
    try {
      return module.totals(runDir).spentUsd;
    } catch {
      return 0;
    }
  };
}

export function priceUsd(
  price: ModelPrice,
  usage: { cachedShare?: number; inputTokens: number; outputTokens: number }
): number {
  const cachedShare = price.cachedInputPerM === undefined ? 0 : (usage.cachedShare ?? 0);
  const cachedTokens = usage.inputTokens * cachedShare;
  const freshTokens = usage.inputTokens - cachedTokens;
  return (
    (freshTokens * price.inputPerM +
      cachedTokens * (price.cachedInputPerM ?? price.inputPerM) +
      usage.outputTokens * price.outputPerM) /
    1_000_000
  );
}
