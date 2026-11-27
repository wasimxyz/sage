// The parts of the runner that can be tried without a Sage build or a model:
// what happens after the pulls, and the order of the stages.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import { loadCacheKeyParts } from "../../evals/lib/cache.ts";
import { expandSetups, parseSweepFile } from "../../evals/lib/schema.ts";
import { snapshotDigests } from "./dream.ts";
import { checkModels } from "./ollama.ts";
import { pullMissing } from "./runner.ts";

const capabilities = ["completion", "embedding", "thinking", "tools"];
const stillNotInOllamaPattern = /chat-only:1b is still not in Ollama/u;

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

test("a sweep with no Chat does not look for the chat model after the pulls", async (t) => {
  const setups = expandSetups(
    parseSweepFile({
      chatModels: ["chat-only:1b"],
      embedModels: ["emb:1b"],
      summaryModels: ["sum:1b"],
    })
  );
  // Ollama holds the summary and embed models, and not the chat model.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") {
        res.end(
          JSON.stringify({
            models: [
              { digest: "sha256:sum", name: "sum:1b" },
              { digest: "sha256:emb", name: "emb:1b" },
            ],
          })
        );
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.model === "chat-only:1b") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ capabilities }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  const host = `127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const inspected = {
    bin: "/none",
    check: { cannotThink: [], missing: ["sum:1b"], problems: [] },
    digests: () => Promise.resolve({}),
  };
  const pulls: string[] = [];
  const deps = {
    host,
    pull: (_bin: string, _host: string, model: string) => {
      pulls.push(model);
      return Promise.resolve();
    },
  };

  const noChat = await pullMissing(inspected, setups, deps, false);
  assert.deepEqual(pulls, ["sum:1b"]);
  assert.deepEqual(await noChat.digests(["sum:1b", "emb:1b", "chat-only:1b"]), {
    "emb:1b": "sha256:emb",
    "sum:1b": "sha256:sum",
  });

  // With Chat, the same Ollama is a problem.
  await assert.rejects(
    pullMissing(inspected, setups, deps, true),
    stillNotInOllamaPattern
  );
});

test("the judge check runs after the estimate is accepted and before anything is pulled, built, or seeded", () => {
  const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  const at = (text: string): number => {
    const found = source.indexOf(text);
    assert.notEqual(found, -1, `${text} is not in runner.ts`);
    assert.equal(
      source.indexOf(text, found + 1),
      -1,
      `${text} appears twice in runner.ts`
    );
    return found;
  };
  const dryRun = at("if (options.dryRun) {");
  const confirm = at("await confirmRun(options);");
  const check = at("await runJudgeCheck(");
  const pull = at("await pullMissing(");
  const build = at("await buildAll(");
  const run = at("await runLoop(ctx, plan);");
  assert.ok(dryRun < confirm, "a dry run never reaches the check");
  assert.ok(confirm < check);
  assert.ok(check < pull);
  assert.ok(pull < build);
  assert.ok(build < run);
  // A failed check ends the run before the next stage.
  const stop = source.slice(check, pull);
  assert.ok(stop.includes("if (!judgeCheck.ok)"));
  assert.ok(stop.includes("throw new Stop("));
  assert.equal(source.includes("skip-judge-check"), false);
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
