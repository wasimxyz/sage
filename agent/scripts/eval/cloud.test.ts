import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";

import { loadPrices, priceCacheFile } from "../../evals/lib/prices.ts";
import { loadPriceBook, simulatedUserProblem } from "./cloud.ts";
import { tempDir } from "./test-fixtures.ts";

const model = "moonshotai/kimi-k3.1-pro";
const noProviderPattern = /None of the providers the sweep names/u;
const fetchFailedPattern = /fetch failed/u;
const couldNotPricePattern = /could not price/u;
const runsConversationsPattern = /runs conversations/u;
const simulatorErrorPattern = /simulator error/u;
const sweepFilePattern = /simulatedUser in the sweep file/u;

test.afterEach(() => {
  mock.restoreAll();
});

test("the runner and the grade processes read one price file, in the sweep's run folder", async (t) => {
  const runDir = tempDir(t);
  // The grader asks for `<runDir>/prices.json`, where runDir is the folder the
  // runner hands it as SAGE_EVAL_RUN_DIR (see grader.test.ts).
  assert.equal(priceCacheFile(runDir), join(runDir, "prices.json"));

  // The runner reads the price list once for its estimate.
  mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({
        data: [
          { id: model, pricing: { input: "0.000002", output: "0.00001" } },
        ],
      })
    )
  );
  const book = await loadPriceBook(
    [{ fallback: { inputPerM: 1, outputPerM: 1 }, id: model }],
    priceCacheFile(runDir)
  );
  assert.deepEqual(book.defaulted, []);
  assert.equal(existsSync(join(runDir, "prices.json")), true);

  // A grade process then finds that read in the same place, without the network.
  mock.restoreAll();
  mock.method(globalThis, "fetch", () => Promise.reject(new Error("offline")));
  const prices = await loadPrices([model], {
    cacheFile: join(runDir, "prices.json"),
  });
  assert.equal(prices[model].inputPerM, 2);
  assert.equal(prices[model].outputPerM, 10);
});

const SIM_SETTINGS = {
  maxOutputPricePerM: 0.5,
  model: "deepseek/deepseek-v4.1-flash",
  providers: ["morph", "deepinfra"],
};

test("the simulated user check passes when a provider is within the limit and the model has a price", async (t) => {
  const problem = await simulatedUserProblem(SIM_SETTINGS, tempDir(t), {
    allowedProviders: () =>
      Promise.resolve({ maxOutputPerM: 0.42, providers: ["deepinfra"] }),
    loadPrices: () =>
      Promise.resolve({
        [SIM_SETTINGS.model]: { inputPerM: 0.2, outputPerM: 0.4 },
      }),
  });
  assert.equal(problem, undefined);
});

test("the simulated user check says why when no provider qualifies, the gateway cannot be read, or the model has no price", async (t) => {
  const runDir = tempDir(t);
  const priced = () =>
    Promise.resolve({
      [SIM_SETTINGS.model]: { inputPerM: 0.2, outputPerM: 0.4 },
    });
  const none = await simulatedUserProblem(SIM_SETTINGS, runDir, {
    allowedProviders: () =>
      Promise.resolve({ maxOutputPerM: 0.4, providers: ["somebody-else"] }),
    loadPrices: priced,
  });
  assert.match(none ?? "", noProviderPattern);
  const down = await simulatedUserProblem(SIM_SETTINGS, runDir, {
    allowedProviders: () => Promise.reject(new Error("fetch failed")),
    loadPrices: priced,
  });
  assert.match(down ?? "", fetchFailedPattern);
  const unpriced = await simulatedUserProblem(SIM_SETTINGS, runDir, {
    allowedProviders: () =>
      Promise.resolve({ maxOutputPerM: 0.4, providers: ["morph"] }),
    loadPrices: () => Promise.resolve({}),
  });
  assert.match(unpriced ?? "", couldNotPricePattern);
  // Every message says what it means for the sweep and what to change.
  for (const problem of [none, down, unpriced]) {
    assert.match(problem ?? "", runsConversationsPattern);
    assert.match(problem ?? "", simulatorErrorPattern);
    assert.match(problem ?? "", sweepFilePattern);
  }
});
