import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type Mock, mock } from "node:test";

import {
  allowedProviders,
  costUsd,
  estimateUsd,
  loadPrices,
  type ModelPrice,
} from "./prices.ts";

const noPriceForBrokenPattern = /no price for: broken\/no-price, not\/listed/u;
const couldNotReadPricesPattern =
  /Could not read prices from the AI Gateway: offline/u;
const answered503Pattern = /answered 503/u;
const noProviderServesDeepseekPattern =
  /No provider serves deepseek\/deepseek-v4.1-flash/u;
const couldNotReadThePattern =
  /Could not read the providers of deepseek\/deepseek-v4.1-flash/u;

// Trimmed copies of what https://ai-gateway.vercel.sh/v1/models and
// /v1/models/<id>/endpoints answered on 2026-11-09.
const catalog = {
  data: [
    {
      id: "moonshotai/kimi-k3.1-pro",
      pricing: {
        input: "0.000002",
        input_cache_read: "0.0000002",
        output: "0.00001",
        regional: { us: { input: "0.0000018", output: "0.000009" } },
        varies_by_provider: true,
      },
    },
    {
      id: "deepseek/deepseek-v4.1-flash",
      pricing: {
        input: "0.0000003",
        input_cache_read: "0.000000007",
        output: "0.0000012",
      },
    },
    {
      id: "alibaba/qwen3-max-thinking",
      pricing: {
        input: "0.0000012",
        input_tiers: [
          { cost: "0.0000012", max: 32_001, min: 0 },
          { cost: "0.0000024", max: 128_001, min: 32_001 },
          { cost: "0.000003", min: 128_001 },
        ],
        output: "0.000006",
        output_tiers: [
          { cost: "0.000006", max: 32_001, min: 0 },
          { cost: "0.000015", min: 128_001 },
        ],
      },
    },
    { id: "broken/no-price", pricing: { input: "0.000001" } },
  ],
  object: "list",
};

const peak = {
  multiplier: 2,
  windows: [{ end_minute_utc: 240, start_minute_utc: 60 }],
};

function endpoint(
  provider: string,
  completion: string,
  extra: Record<string, unknown> = {}
) {
  return {
    pricing: { completion, prompt: "0.0000001", ...extra },
    provider_name: provider,
  };
}

const endpoints = {
  data: {
    endpoints: [
      endpoint("deepinfra", "0.00000042"),
      endpoint("morph", "0.0000004"),
      endpoint("runinfra", "0.000000464"),
      endpoint("relace", "0.0000005"),
      endpoint("pareto", "0.0000003", { peak_pricing: peak }),
      endpoint("alibaba", "0.0000006", { peak_pricing: peak }),
      endpoint("baseten", "0.0000012"),
    ],
    id: "deepseek/deepseek-v4.1-flash",
  },
};

type Responder = (url: string) => unknown;

function stubFetch(respond: Responder): Mock<typeof fetch> {
  return mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input);
    const body = respond(url);
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    if (typeof body === "number") {
      return Promise.resolve(new Response("nope", { status: body }));
    }
    return Promise.resolve(Response.json(body));
  }) as unknown as Mock<typeof fetch>;
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sage-prices-")), "prices.json");
}

function urlsOf(fetchMock: Mock<typeof fetch>): string[] {
  return fetchMock.mock.calls.map((call) => String(call.arguments[0]));
}

test.afterEach(() => {
  mock.restoreAll();
});

test("loadPrices turns USD per token into USD per million tokens", async () => {
  const fetchMock = stubFetch(() => catalog);
  const prices = await loadPrices([
    "moonshotai/kimi-k3.1-pro",
    "deepseek/deepseek-v4.1-flash",
  ]);
  assert.deepEqual(prices, {
    "deepseek/deepseek-v4.1-flash": {
      cachedInputPerM: 0.007,
      inputPerM: 0.3,
      outputPerM: 1.2,
    },
    "moonshotai/kimi-k3.1-pro": {
      cachedInputPerM: 0.2,
      inputPerM: 2,
      outputPerM: 10,
    },
  });
  assert.deepEqual(urlsOf(fetchMock), [
    "https://ai-gateway.vercel.sh/v1/models",
  ]);
});

test("loadPrices uses the dearest tier so an estimate is never low", async () => {
  stubFetch(() => catalog);
  const prices = await loadPrices(["alibaba/qwen3-max-thinking"]);
  assert.deepEqual(prices["alibaba/qwen3-max-thinking"], {
    inputPerM: 3,
    outputPerM: 15,
  });
});

test("loadPrices names every model that has no price", async () => {
  stubFetch(() => catalog);
  await assert.rejects(
    loadPrices(["moonshotai/kimi-k3.1-pro", "broken/no-price", "not/listed"]),
    noPriceForBrokenPattern
  );
});

test("loadPrices saves a cache file and reuses it while it is fresh", async () => {
  const cacheFile = tempFile();
  const fetchMock = stubFetch(() => catalog);
  const first = await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  const second = await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  assert.deepEqual(second, first);
  assert.equal(fetchMock.mock.callCount(), 1);
  const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.equal(saved.models["moonshotai/kimi-k3.1-pro"].price.inputPerM, 2);
});

test("loadPrices adds a new model to the cache without dropping the others", async () => {
  const cacheFile = tempFile();
  const fetchMock = stubFetch(() => catalog);
  await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  const both = await loadPrices(
    ["moonshotai/kimi-k3.1-pro", "deepseek/deepseek-v4.1-flash"],
    { cacheFile }
  );
  assert.equal(Object.keys(both).length, 2);
  assert.equal(fetchMock.mock.callCount(), 2);
  const onlyFirst = await loadPrices(["moonshotai/kimi-k3.1-pro"], {
    cacheFile,
  });
  assert.equal(onlyFirst["moonshotai/kimi-k3.1-pro"].outputPerM, 10);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("loadPrices reads the catalog again when the cache is old", async () => {
  const cacheFile = tempFile();
  const fetchMock = stubFetch(() => catalog);
  await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
  saved.models["moonshotai/kimi-k3.1-pro"].fetchedAt = new Date(
    Date.now() - 2 * 60 * 60 * 1000
  ).toISOString();
  saved.models["moonshotai/kimi-k3.1-pro"].price.outputPerM = 99;
  writeFileSync(cacheFile, JSON.stringify(saved));
  const prices = await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  assert.equal(prices["moonshotai/kimi-k3.1-pro"].outputPerM, 10);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("loadPrices falls back to an old cache when the catalog is unreachable", async () => {
  const cacheFile = tempFile();
  stubFetch(() => catalog);
  await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
  saved.models["moonshotai/kimi-k3.1-pro"].fetchedAt = "2020-01-01T00:00:00Z";
  writeFileSync(cacheFile, JSON.stringify(saved));
  mock.restoreAll();
  stubFetch(() => new Error("offline"));
  const prices = await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  assert.equal(prices["moonshotai/kimi-k3.1-pro"].inputPerM, 2);
});

test("loadPrices throws when the catalog is unreachable and the cache lacks a model", async () => {
  stubFetch(() => new Error("offline"));
  await assert.rejects(
    loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile: tempFile() }),
    couldNotReadPricesPattern
  );
});

test("loadPrices ignores a damaged cache file", async () => {
  const cacheFile = tempFile();
  writeFileSync(cacheFile, "{not json");
  utimesSync(cacheFile, new Date(), new Date());
  stubFetch(() => catalog);
  const prices = await loadPrices(["moonshotai/kimi-k3.1-pro"], { cacheFile });
  assert.equal(prices["moonshotai/kimi-k3.1-pro"].inputPerM, 2);
});

test("loadPrices reports an HTTP error", async () => {
  stubFetch(() => 503);
  await assert.rejects(
    loadPrices(["moonshotai/kimi-k3.1-pro"]),
    answered503Pattern
  );
});

test("allowedProviders keeps providers at or under the limit, counting peak hours", async () => {
  const fetchMock = stubFetch(() => endpoints);
  const result = await allowedProviders("deepseek/deepseek-v4.1-flash", 0.5);
  // pareto is $0.30 but doubles at peak hours, so $0.60 is over the limit.
  assert.deepEqual(result, {
    maxOutputPerM: 0.5,
    outputPerM: { deepinfra: 0.42, morph: 0.4, relace: 0.5, runinfra: 0.464 },
    providers: ["morph", "deepinfra", "runinfra", "relace"],
  });
  assert.deepEqual(urlsOf(fetchMock), [
    "https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4.1-flash/endpoints",
  ]);
});

test("allowedProviders reports the dearest allowed price", async () => {
  stubFetch(() => endpoints);
  const result = await allowedProviders("deepseek/deepseek-v4.1-flash", 0.45);
  assert.deepEqual(result.providers, ["morph", "deepinfra"]);
  assert.equal(result.maxOutputPerM, 0.42);
  // Each provider's own price is there, so a caller can price a subset.
  assert.deepEqual(result.outputPerM, { deepinfra: 0.42, morph: 0.4 });
});

test("allowedProviders throws when nothing is cheap enough", async () => {
  stubFetch(() => endpoints);
  await assert.rejects(
    allowedProviders("deepseek/deepseek-v4.1-flash", 0.1),
    noProviderServesDeepseekPattern
  );
});

test("allowedProviders names the model when the catalog cannot be read", async () => {
  stubFetch(() => 404);
  await assert.rejects(
    allowedProviders("deepseek/deepseek-v4.1-flash", 0.5),
    couldNotReadThePattern
  );
});

const price: ModelPrice = {
  cachedInputPerM: 0.2,
  inputPerM: 2,
  outputPerM: 10,
};

test("costUsd bills fresh input, cached input, and output separately", () => {
  const cost = costUsd(price, {
    cachedInputTokens: 600_000,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
  });
  // 400k fresh at $2 + 600k cached at $0.20 + 100k output at $10.
  assert.ok(Math.abs(cost - (0.8 + 0.12 + 1)) < 1e-9);
});

test("costUsd bills cached tokens as input when the model has no cache price", () => {
  const cost = costUsd(
    { inputPerM: 2, outputPerM: 10 },
    { cachedInputTokens: 500_000, inputTokens: 1_000_000, outputTokens: 0 }
  );
  assert.ok(Math.abs(cost - 2) < 1e-9);
});

test("costUsd never bills more cached tokens than input tokens", () => {
  const cost = costUsd(price, {
    cachedInputTokens: 5_000_000,
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  assert.ok(Math.abs(cost - 0.2) < 1e-9);
});

test("estimateUsd is prompt chars over four at the input price plus the expected output", () => {
  const estimate = estimateUsd(price, {
    outputTokens: 1500,
    promptChars: 40_000,
  });
  // 10k tokens at $2/M + 1500 tokens at $10/M.
  assert.ok(Math.abs(estimate - (0.02 + 0.015)) < 1e-9);
});
