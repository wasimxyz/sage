import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";

import { loadPrices, priceCacheFile } from "../../evals/lib/prices.ts";
import { loadPriceBook } from "./cloud.ts";
import { tempDir } from "./test-fixtures.ts";

const model = "moonshotai/kimi-k3.1-pro";

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
