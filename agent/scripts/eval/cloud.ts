// The runner's side of the cloud prices and the spending ledger, which the
// judge owns (`agent/evals/lib/prices.ts` and `agent/evals/lib/ledger.ts`).
//
// When the gateway's price list cannot be read (no network), the estimate
// falls back to the default prices below and says so.

import { totals } from "../../evals/lib/ledger.ts";
import { loadPrices, type ModelPrice } from "../../evals/lib/prices.ts";
import type { SimulatedUserSettings } from "../../evals/lib/schema.ts";
import {
  resolveSimulatedUser,
  type SimulatedUserOptions,
} from "../../evals/lib/simulated-user.ts";

export type { ModelPrice } from "../../evals/lib/prices.ts";

/** Used when the gateway's price list cannot be read. Per million tokens. */
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 2, outputPerM: 10 };
export const DEFAULT_SIMULATED_USER_PRICE: ModelPrice = {
  inputPerM: 0.14,
  outputPerM: 0.5,
};

export interface PriceBook {
  /** Models that have the built-in default price. */
  defaulted: string[];
  prices: Record<string, ModelPrice>;
}

/**
 * Prices for the given models. A model the gateway does not list, or any
 * failure, gets the default price for its role and is named in `defaulted`.
 */
export async function loadPriceBook(
  models: { fallback: ModelPrice; id: string }[],
  cacheFile: string
): Promise<PriceBook> {
  const prices: Record<string, ModelPrice> = {};
  const defaulted: string[] = [];
  for (const model of models) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: two models, and one failing must not hide the other.
      const loaded = await loadPrices([model.id], { cacheFile });
      prices[model.id] = loaded[model.id] ?? model.fallback;
      if (loaded[model.id] === undefined) {
        defaulted.push(model.id);
      }
    } catch {
      prices[model.id] = model.fallback;
      defaulted.push(model.id);
    }
  }
  return { defaulted, prices };
}

/**
 * Why the simulated user cannot run, or undefined when it can. It reads what
 * the first call of a conversation would read: the providers the gateway
 * lists for the model, and the model's price. A sweep that runs conversations
 * asks this before any local work, because a simulated user that is not
 * available ends every conversation as `simulator-error`, and a night of
 * generation would be spent on conversations that never held.
 */
export async function simulatedUserProblem(
  settings: SimulatedUserSettings,
  runDir: string,
  deps: Pick<SimulatedUserOptions, "allowedProviders" | "loadPrices"> = {}
): Promise<string | undefined> {
  const resolved = await resolveSimulatedUser({ ...deps, runDir, settings });
  if (resolved.ok) {
    return undefined;
  }
  return `The simulated user cannot run, and this sweep runs conversations: ${resolved.reason}\nEvery conversation would end as a simulator error. Fix simulatedUser in the sweep file (providers, maxOutputPricePerM), or take conversations out of its tests.`;
}

/** The sweep's settled spending so far, in dollars. Zero before the ledger exists. */
export function spentUsd(runDir: string): number {
  try {
    return totals(runDir).spentUsd;
  } catch {
    return 0;
  }
}
