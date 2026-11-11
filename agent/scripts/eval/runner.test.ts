// The parts of the runner that can be tried without a Sage build or a model:
// what happens after the pulls.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { loadCacheKeyParts } from "../../evals/lib/cache.ts";
import { expandSetups, parseSweepFile } from "../../evals/lib/schema.ts";
import { snapshotDigests } from "./dream.ts";
import { checkModels } from "./ollama.ts";
import { pullMissing } from "./runner.ts";

const capabilities = ["completion", "embedding", "thinking", "tools"];

test("the digests the runner keys Dream with include the models it just pulled", async (t) => {
  const setups = expandSetups(parseSweepFile({}));
  const models = [
    ...new Set(
      setups.flatMap((setup) => [
        setup.chatModel,
        setup.embedModel,
        setup.summaryModel,
      ])
    ),
  ];
  // An Ollama that has nothing until a pull puts the models in.
  let pulled = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!pulled) {
      res.statusCode = req.url === "/api/tags" ? 200 : 404;
      res.end(req.url === "/api/tags" ? '{"models":[]}' : "{}");
    } else if (req.url === "/api/tags") {
      res.end(
        JSON.stringify({
          models: models.map((name) => ({ digest: `sha256:${name}`, name })),
        })
      );
    } else {
      res.end(JSON.stringify({ capabilities }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const host = `127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  // The first look, before any pull: nothing is there, so there are no digests.
  const before = await snapshotDigests(models, host);
  assert.deepEqual(await before(models), {});
  const check = await checkModels(host, {
    chat: [...new Set(setups.map((setup) => setup.chatModel))],
    embed: [...new Set(setups.map((setup) => setup.embedModel))],
    summary: [...new Set(setups.map((setup) => setup.summaryModel))],
  });
  assert.deepEqual([...check.missing].sort(), [...models].sort());

  const pullsMade: string[] = [];
  const result = await pullMissing(
    { bin: "/none", check, digests: before },
    setups,
    {
      host,
      pull: (_bin, _host, model) => {
        pullsMade.push(model);
        pulled = true;
        return Promise.resolve();
      },
    }
  );
  assert.deepEqual([...pullsMade].sort(), [...models].sort());

  // The lookup the units get was read after the pulls, so every model has its digest.
  const found = await result.digests(models);
  for (const model of models) {
    assert.equal(found[model], `sha256:${model}`);
  }
  const parts = await loadCacheKeyParts(
    {
      dreamPrompt: "baseline",
      embedModel: setups[0]?.embedModel ?? "",
      memory: "off",
      person: "sam-example",
      summaryModel: setups[0]?.summaryModel ?? "",
    },
    result.digests
  );
  assert.equal(parts.summaryDigest, `sha256:${setups[0]?.summaryModel}`);
  assert.equal(parts.embedDigest, `sha256:${setups[0]?.embedModel}`);
});

test("with nothing to pull, the digests read earlier are kept", async () => {
  const setups = expandSetups(parseSweepFile({}));
  const digests = () => Promise.resolve({ "some:model": "sha256:a" });
  const result = await pullMissing(
    {
      bin: "/none",
      check: { cannotThink: ["no-think:1b"], missing: [], problems: [] },
      digests,
    },
    setups,
    {
      host: "127.0.0.1:1",
      pull: () => Promise.reject(new Error("nothing should be pulled")),
    }
  );
  assert.equal(result.digests, digests);
  assert.deepEqual([...result.cannotThink], ["no-think:1b"]);
});
