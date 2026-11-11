import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test from "node:test";

import {
  canThink,
  checkModels,
  type ModelInfo,
  modelProblems,
  ollamaApiBase,
  ollamaUp,
  parseModelInfo,
  pullModel,
  runningModels,
  showModel,
  startPullServer,
  unloadModel,
  waitForOllamaGone,
  warmUpModel,
} from "./ollama.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern1 = /gemma cannot call tools/u;
const pattern2 = /cannot be the embed model/u;
const pattern3 = /cannot be the summary model/u;
const pattern4 = /not in Ollama/u;
const pattern5 = /did not say what m can do/u;
const pattern6 = /gemma:12b cannot call tools/u;
const pattern7 = /already in use/u;
const pattern8 = /did not start[\s\S]*cannot bind/u;
const pattern9 = /Could not pull bad/u;
const pattern10 = /still answering/u;

interface Seen {
  generate: Record<string, unknown>[];
}

const models: Record<string, unknown> = {
  "embed:1": { capabilities: ["embedding"] },
  "gemma:12b": { capabilities: ["completion", "vision"] },
  "qwen:9b": { capabilities: ["completion", "tools", "thinking"] },
  "tools:8b": { capabilities: ["completion", "tools"] },
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : 0
      );
    });
  });
}

async function fakeOllama(
  t: test.TestContext
): Promise<{ host: string; seen: Seen }> {
  const seen: Seen = { generate: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body =
        chunks.length > 0
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/version") {
        res.end('{"version":"0.0.0"}');
      } else if (req.url === "/api/show") {
        const info = models[body.model as string];
        if (info === undefined) {
          res.statusCode = 404;
          res.end('{"error":"model not found"}');
        } else {
          res.end(JSON.stringify(info));
        }
      } else if (req.url === "/api/generate") {
        seen.generate.push(body);
        res.end('{"done":true}');
      } else if (req.url === "/api/ps") {
        res.end('{"models":[{"name":"qwen:9b","size":1234},{"nope":1}]}');
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return { host: `127.0.0.1:${port}`, seen };
}

async function freeHost(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return `127.0.0.1:${port}`;
}

test("parseModelInfo reads capabilities and thinking values", () => {
  assert.deepEqual(
    parseModelInfo({
      capabilities: ["completion", 3, "tools"],
      thinking: { values: [true, false, "high", 1] },
    }),
    {
      capabilities: ["completion", "tools"],
      thinkingValues: [true, false, "high"],
    }
  );
  assert.deepEqual(parseModelInfo(null), {
    capabilities: null,
    thinkingValues: null,
  });
  assert.deepEqual(parseModelInfo({}), {
    capabilities: null,
    thinkingValues: null,
  });
});

test("canThink follows capabilities, then the think values", () => {
  assert.equal(
    canThink({ capabilities: ["thinking"], thinkingValues: null }),
    true
  );
  assert.equal(
    canThink({ capabilities: ["completion"], thinkingValues: [true, false] }),
    true
  );
  assert.equal(
    canThink({ capabilities: ["completion"], thinkingValues: ["low", "high"] }),
    true
  );
  assert.equal(
    canThink({ capabilities: ["completion"], thinkingValues: [false] }),
    false
  );
  assert.equal(
    canThink({ capabilities: ["completion"], thinkingValues: null }),
    false
  );
  assert.equal(canThink({ capabilities: null, thinkingValues: null }), false);
});

test("modelProblems rejects chat models without tools, and misfit embed and summary models", () => {
  const withTools: ModelInfo = {
    capabilities: ["completion", "tools"],
    thinkingValues: null,
  };
  const noTools: ModelInfo = {
    capabilities: ["completion", "vision"],
    thinkingValues: null,
  };
  const embedding: ModelInfo = {
    capabilities: ["embedding"],
    thinkingValues: null,
  };
  assert.deepEqual(modelProblems("m", "chat", withTools), []);
  assert.match(modelProblems("gemma", "chat", noTools)[0] ?? "", pattern1);
  assert.deepEqual(modelProblems("e", "embed", embedding), []);
  assert.match(modelProblems("m", "embed", withTools)[0] ?? "", pattern2);
  assert.deepEqual(modelProblems("m", "summary", withTools), []);
  assert.match(modelProblems("e", "summary", embedding)[0] ?? "", pattern3);
  assert.match(modelProblems("m", "chat", null)[0] ?? "", pattern4);
  assert.match(
    modelProblems("m", "chat", {
      capabilities: null,
      thinkingValues: null,
    })[0] ?? "",
    pattern5
  );
});

test("showModel reads a model, and answers null for one Ollama lacks", async (t) => {
  const { host } = await fakeOllama(t);
  assert.equal(await ollamaUp(host), true);
  const info = await showModel(host, "qwen:9b");
  assert.deepEqual(info?.capabilities, ["completion", "tools", "thinking"]);
  assert.equal(await showModel(host, "nope:1"), null);
  assert.equal(ollamaApiBase(host), `http://${host}/api`);
});

test("checkModels lists missing models, problems, and chat models that cannot think", async (t) => {
  const { host } = await fakeOllama(t);
  const check = await checkModels(host, {
    chat: ["qwen:9b", "tools:8b", "gemma:12b", "missing:1"],
    embed: ["embed:1"],
    summary: ["qwen:9b"],
  });
  assert.deepEqual(check.missing, ["missing:1"]);
  assert.deepEqual(check.cannotThink, ["tools:8b", "gemma:12b"]);
  assert.equal(check.problems.length, 1);
  assert.match(check.problems[0] ?? "", pattern6);
});

test("warmUpModel loads at a context length, and unloadModel sends keep_alive 0", async (t) => {
  const { host, seen } = await fakeOllama(t);
  await warmUpModel(host, "qwen:9b", 16_384);
  await unloadModel(host, "qwen:9b");
  assert.deepEqual(seen.generate[0], {
    keep_alive: "30m",
    model: "qwen:9b",
    options: { num_ctx: 16_384 },
  });
  assert.deepEqual(seen.generate[1], { keep_alive: 0, model: "qwen:9b" });
  // The empty prompt is what loads without generating.
  assert.equal("prompt" in (seen.generate[0] ?? {}), false);
});

test("unloadModel does not throw when nothing answers", async () => {
  await unloadModel(await freeHost(), "qwen:9b");
});

test("runningModels lists loaded models and ignores odd rows", async (t) => {
  const { host } = await fakeOllama(t);
  assert.deepEqual(await runningModels(host), [
    { name: "qwen:9b", size: 1234 },
  ]);
});

const fakeBinary = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "serve") {
  const [host, port] = process.env.OLLAMA_HOST.split(":");
  http.createServer((req, res) => res.end("{}")).listen(Number(port), host);
  process.on("SIGTERM", () => process.exit(0));
} else if (args[0] === "pull") {
  console.log("pulling " + args[1] + " via " + process.env.OLLAMA_HOST);
  process.exit(args[1] === "bad" ? 1 : 0);
}
`;

function writeFakeBinary(dir: string): string {
  const path = join(dir, "ollama");
  writeFileSync(path, fakeBinary);
  chmodSync(path, 0o755);
  return path;
}

test("the pull server starts on the host, goes away when stopped, and refuses a busy port", async (t) => {
  const dir = tempDir(t);
  const bin = writeFakeBinary(dir);
  const host = await freeHost();
  const server = await startPullServer({ bin, host, startTimeoutMs: 20_000 });
  assert.equal(await ollamaUp(host), true);
  await assert.rejects(startPullServer({ bin, host }), pattern7);
  await server.stop();
  await waitForOllamaGone(host, 10_000);
  assert.equal(await ollamaUp(host), false);
});

test("the pull server fails with the log when Ollama exits", async (t) => {
  const dir = tempDir(t);
  const bin = join(dir, "ollama");
  writeFileSync(bin, "#!/bin/sh\necho 'cannot bind' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  await assert.rejects(
    startPullServer({ bin, host: await freeHost(), startTimeoutMs: 10_000 }),
    pattern8
  );
});

test("pullModel runs ollama pull against the host and reports a failure", async (t) => {
  const dir = tempDir(t);
  const bin = writeFakeBinary(dir);
  await pullModel(bin, "127.0.0.1:1", "qwen:9b");
  await assert.rejects(pullModel(bin, "127.0.0.1:1", "bad"), pattern9);
});

test("waitForOllamaGone fails while something still answers", async (t) => {
  const { host } = await fakeOllama(t);
  await assert.rejects(waitForOllamaGone(host, 300), pattern10);
});
