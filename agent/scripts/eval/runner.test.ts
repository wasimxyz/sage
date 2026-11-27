// The parts of the runner that can be tried without a Sage build or a model:
// what happens after the pulls, and the order of the stages.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { loadCacheKeyParts } from "../../evals/lib/cache.ts";
import { expandSetups, parseSweepFile } from "../../evals/lib/schema.ts";
import { snapshotDigests } from "./dream.ts";
import { checkModels } from "./ollama.ts";
import { createProgress, isDone, newPlanFile } from "./resume.ts";
import { judgeCheckOnce, pullMissing, sweepNameOf } from "./runner.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern3 = /passed in an earlier run/u;
const pattern2 =
  /missed crisis-handled in judge-check\/reply\/missed-crisis|crisis-handled/u;
const pattern1 = /run-1 is a screen sweep, and --sweep says deep/u;

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
  const whole = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  // The sweeps with setups only. Calibration and head-to-head have their own
  // flow after it, which is checked on its own below.
  const source = whole.slice(
    whole.indexOf("async function sweepBody("),
    whole.indexOf("// Sweeps with no Sage: calibration and head-to-head")
  );
  const at = (text: string): number => {
    const found = source.indexOf(text);
    assert.notEqual(found, -1, `${text} is not in the flow of a sweep`);
    assert.equal(
      source.indexOf(text, found + 1),
      -1,
      `${text} appears twice in the flow of a sweep`
    );
    return found;
  };
  const dryRun = at("if (options.dryRun) {");
  const confirm = at("await confirmRun(options);");
  const check = at("await judgeCheckOnce(");
  const pull = at("await pullMissing(");
  const build = at("await buildAll(");
  const run = at("await runLoop(ctx, plan);");
  assert.ok(dryRun < confirm, "a dry run never reaches the check");
  assert.ok(confirm < check);
  assert.ok(check < pull);
  assert.ok(pull < build);
  assert.ok(build < run);
  // A failed check ends the run before the next stage.
  const once = whole.slice(
    whole.indexOf("async function judgeCheckOnce("),
    whole.indexOf("// The run\n")
  );
  assert.ok(once.includes("await runJudgeCheck("));
  assert.ok(once.includes("if (!result.ok)"));
  assert.ok(once.includes("throw new Stop("));
  assert.equal(whole.includes("skip-judge-check"), false);
});

test("head-to-head runs the judge check after the estimate is accepted, and calibration never does", () => {
  const whole = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  const start = whole.indexOf("async function runStandaloneSweep(");
  const body = whole.slice(start, whole.indexOf("function reportCalibration("));
  const confirm = body.indexOf("await confirmRun(options);");
  const check = body.indexOf("await runJudgeCheck(");
  const pass = body.indexOf("await runStandalone(");
  assert.ok(confirm > -1 && confirm < check && check < pass);
  assert.ok(body.includes('kind === "head-to-head"'));
  assert.equal(body.indexOf("await runJudgeCheck(", check + 1), -1);
  assert.ok(body.includes("if (!check.ok)"));
});

test("a standalone sweep writes its result only after a pass that finished, and Ctrl-C reaches it", () => {
  const whole = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  const start = whole.indexOf("async function runStandaloneSweep(");
  const body = whole.slice(start, whole.indexOf("function reportCalibration("));
  const gate = body.indexOf("unwrittenReason(kind, result, abort.aborted)");
  assert.ok(gate > body.indexOf("await runStandalone("));
  assert.ok(body.indexOf("reportCalibration(") > gate);
  assert.ok(body.indexOf("reportHeadToHead(") > gate);
  assert.ok(body.includes("abort: { aborted: boolean }"));
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

// ---------------------------------------------------------------------------
// The judge check, once for a resumed sweep
// ---------------------------------------------------------------------------

function checkRun(dir: string) {
  return {
    agentDir: join(dir, "agent"),
    credentials: { AI_GATEWAY_API_KEY: "gateway-key-0123456789" },
    runDir: join(dir, "run"),
    stubUrl: "http://127.0.0.1:4242",
    sweepFile: join(dir, "run", "sweep.json"),
    sweepId: "2026-11-10T031500Z-screen",
  };
}

/** A pass that records one judge-check row, as the real one does. */
function fakeCheckPass(options: {
  passes: boolean;
  passesRun: { count: number };
}) {
  return (_command: unknown, run: { env: Record<string, string> }) => {
    options.passesRun.count += 1;
    appendFileSync(
      run.env.SAGE_EVAL_RESULTS as string,
      `${JSON.stringify({
        assertions: [
          {
            metadata: options.passes
              ? { checkId: "judge-check", tier: "hard" }
              : {
                  checkId: "judge-check",
                  misses: [
                    {
                      check: "crisis-handled",
                      detail: "The judge let it through.",
                      itemId: "judge-check/reply/missed-crisis",
                      kind: "missed",
                    },
                  ],
                  tier: "hard",
                },
            name: "hard:judge-check",
            passed: options.passes,
            score: options.passes ? 1 : 0,
            severity: "gate",
          },
        ],
        completedAt: "2026-11-10T03:00:01.000Z",
        id: "judge-check/reply/x",
        metadata: {
          itemId: "judge-check/reply/x",
          kind: "opener",
          person: "judge-check",
          repeat: 1,
          setupId: "judge-check",
        },
        startedAt: "2026-11-10T03:00:00.000Z",
        verdict: options.passes ? "passed" : "failed",
      })}\n`
    );
    return Promise.resolve({ code: 0, durationMs: 1, status: "ok" as const });
  };
}

test("a judge check that passed in an earlier run is not run again", async (t) => {
  const dir = tempDir(t);
  const progress = createProgress(join(dir, "run"));
  const passesRun = { count: 0 };
  const deps = { runPass: fakeCheckPass({ passes: true, passesRun }) as never };
  const first = await judgeCheckOnce(progress, checkRun(dir), deps);
  assert.equal(first.ok, true);
  assert.equal(first.checked, 1);
  assert.equal(passesRun.count, 1);
  assert.equal(isDone(join(dir, "run"), { kind: "judge-check" }), true);

  const again = await judgeCheckOnce(progress, checkRun(dir), deps);
  assert.equal(again.ok, true);
  assert.equal(passesRun.count, 1, "no second run");
  assert.deepEqual(again.summary, { misses: [], passed: true });
  assert.match(again.lines.join(" "), pattern3);
});

test("a judge check that missed stops the sweep, leaves no marker, and starts from scratch when it is tried again", async (t) => {
  const dir = tempDir(t);
  const runDir = join(dir, "run");
  const progress = createProgress(runDir);
  const passesRun = { count: 0 };
  await assert.rejects(
    judgeCheckOnce(progress, checkRun(dir), {
      runPass: fakeCheckPass({ passes: false, passesRun }) as never,
    }),
    pattern2
  );
  assert.equal(isDone(runDir, { kind: "judge-check" }), false);

  // A resume tries again. The rows of the first try are gone, so the check
  // reads one row, not two.
  const result = await judgeCheckOnce(progress, checkRun(dir), {
    runPass: fakeCheckPass({ passes: true, passesRun }) as never,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.equal(passesRun.count, 2);
});

test("a resumed run uses the sweep its plan recorded, and refuses another one named for it", () => {
  const options = (sweep: string) => ({
    dryRun: false,
    eveFilters: [],
    help: false,
    sweep,
    yes: false,
  });
  const recorded = newPlanFile("run-1", {
    people: ["sam"],
    setupIds: ["a1a1a1a1a1"],
    sweepFile: "screen",
    sweepHash: "0123456789abcdef",
  });
  // A new run takes --sweep, which `make eval` always passes.
  assert.equal(sweepNameOf(options("smoke"), null), "smoke");
  // make eval passes --sweep default when SWEEP is not set, which is no choice.
  assert.equal(sweepNameOf(options("default"), recorded), "screen");
  assert.equal(sweepNameOf(options("screen"), recorded), "screen");
  assert.throws(() => sweepNameOf(options("deep"), recorded), pattern1);
});
