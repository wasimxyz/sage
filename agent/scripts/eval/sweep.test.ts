import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { setupId } from "../../evals/lib/schema.ts";
import {
  applyModelOverrides,
  availableSweeps,
  defaultSweepsDir,
  loadSweep,
  makeSweepId,
  resolvedSweepJson,
  splitModelList,
  thinkingProblems,
} from "./sweep.ts";
import { tempDir } from "./test-fixtures.ts";

const pattern5 = /only head-to-head and calibration read it/u;

const pattern1 = /Thinking "high" is not supported yet/u;
const pattern2 = /No sweep file .*Sweeps here: smoke/u;
const pattern3 = /not a sweep name/u;
const pattern4 = /Invalid sweep file bad\.yaml/u;

function sweepsIn(t: test.TestContext, files: Record<string, string>): string {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.yaml`), text);
  }
  return dir;
}

test("the sweeps that ship parse, and default runs memory off and on", async () => {
  const names = availableSweeps();
  assert.ok(names.includes("default"));
  assert.ok(names.includes("smoke"));
  const dir = defaultSweepsDir();
  const standard = await loadSweep("default", {}, dir);
  assert.deepEqual(standard.sweep.memory, ["off", "on"]);
  assert.deepEqual(standard.sweep.tests, [
    "person",
    "dream-accuracy",
    "facts",
    "openers",
  ]);
  assert.equal(standard.setups.length, 2);
  assert.equal(standard.sweep.spendingCapUsd, 50);

  const smoke = await loadSweep("smoke", {}, dir);
  assert.equal(smoke.setups.length, 1);
  assert.deepEqual(smoke.sweep.tags, ["example"]);
  // One short conversation, so the simulated user runs end to end.
  assert.deepEqual(smoke.sweep.tests, [
    "person",
    "facts",
    "openers",
    "conversations",
  ]);
  assert.ok(names.includes("screen"));
  // The judge check is most of smoke's cost, so the cap leaves room for it.
  // `judge-check.test.ts` runs the whole check under this cap.
  assert.equal(smoke.sweep.spendingCapUsd, 3);
});

test("only the deep and dream sweeps include long-history, and the deep sweeps run the person checks and conversations three times", async () => {
  const dir = defaultSweepsDir();
  const names = availableSweeps();
  for (const name of ["default", "smoke", "quick", "screen"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep loads on its own
    const { sweep } = await loadSweep(name, {}, dir);
    assert.deepEqual(sweep.excludeTags, ["long"], name);
  }
  for (const name of ["deep", "deep-memory-on", "dream"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each sweep loads on its own
    const { sweep } = await loadSweep(name, {}, dir);
    assert.deepEqual(sweep.excludeTags, [], name);
  }
  for (const [name, memory] of [
    ["deep", ["off"]],
    ["deep-memory-on", ["on"]],
  ] as const) {
    assert.ok(names.includes(name));
    // biome-ignore lint/performance/noAwaitInLoops: each sweep loads on its own
    const deep = await loadSweep(name, {}, dir);
    assert.deepEqual(deep.sweep.tests, ["person", "conversations"], name);
    assert.equal(deep.sweep.repeats, 3, name);
    assert.deepEqual(deep.sweep.memory, memory, name);
    assert.equal(deep.sweep.simulatedUser.maxOutputPricePerM, 0.5);
    assert.equal(
      deep.sweep.simulatedUser.model,
      "deepseek/deepseek-v4.1-flash"
    );
  }
});

test("a sweep file takes the defaults for what it leaves out", async (t) => {
  const dir = sweepsIn(t, { tiny: "chatModels: [a, b]\n" });
  const loaded = await loadSweep("tiny", {}, dir);
  assert.equal(loaded.setups.length, 2);
  assert.deepEqual(loaded.sweep.prompts, ["baseline"]);
  assert.equal(loaded.sweep.speedLimitSeconds, 20);
  assert.equal(loaded.name, "tiny");
  assert.equal(loaded.path, join(dir, "tiny.yaml"));
});

test("model lists in the environment replace the file's", async (t) => {
  const dir = sweepsIn(t, {
    tiny: "summaryModels: [s]\nembedModels: [e]\nchatModels: [c]\n",
  });
  const loaded = await loadSweep(
    "tiny",
    {
      SAGE_CHAT_MODELS: "ollama/x:1, y:2 ,x:1",
      SAGE_EMBED_MODELS: "",
      SAGE_SUMMARY_MODELS: "s2",
    },
    dir
  );
  assert.deepEqual(loaded.sweep.chatModels, ["x:1", "y:2"]);
  assert.deepEqual(loaded.sweep.summaryModels, ["s2"]);
  assert.deepEqual(
    loaded.sweep.embedModels,
    ["e"],
    "an empty list keeps the file's"
  );
  assert.deepEqual(loaded.overrides.sort(), [
    "SAGE_CHAT_MODELS",
    "SAGE_SUMMARY_MODELS",
  ]);
  assert.equal(loaded.setups.length, 2);
});

test("splitModelList and applyModelOverrides", () => {
  assert.deepEqual(splitModelList(" a, ,b,a ,ollama/c "), ["a", "b", "c"]);
  assert.deepEqual(splitModelList(""), []);
  const { applied, doc } = applyModelOverrides(
    { chatModels: ["a"] },
    { SAGE_CHAT_MODELS: "b" }
  );
  assert.deepEqual(applied, ["SAGE_CHAT_MODELS"]);
  assert.deepEqual(doc.chatModels, ["b"]);
});

test("thinking levels the agent cannot honor are refused", async (t) => {
  assert.deepEqual(thinkingProblems({ thinking: ["off", "on"] }), []);
  assert.equal(thinkingProblems({ thinking: ["on", "high"] }).length, 1);
  const dir = sweepsIn(t, { levels: "thinking: [off, high]\n" });
  await assert.rejects(loadSweep("levels", {}, dir), pattern1);
});

test("a missing sweep names the ones there are, and a bad name is refused", async (t) => {
  const dir = sweepsIn(t, { smoke: "chatModels: [a]\n" });
  await assert.rejects(loadSweep("nope", {}, dir), pattern2);
  await assert.rejects(loadSweep("../etc/passwd", {}, dir), pattern3);
  await assert.rejects(loadSweep("Smoke", {}, dir), pattern3);
});

test("a sweep file with an unknown key is refused with its problem", async (t) => {
  const dir = sweepsIn(t, { bad: "chatModel: [a]\n" });
  await assert.rejects(loadSweep("bad", {}, dir), pattern4);
});

test("sweep ids start with the UTC date and are safe in a file name", () => {
  const id = makeSweepId("smoke", new Date("2026-11-10T03:15:00.789Z"));
  assert.equal(id, "2026-11-10T031500Z-smoke");
  assert.ok(!id.includes("__"));
  assert.ok(!id.includes(":"));
});

test("the resolved sweep JSON parses back into the same setups", async (t) => {
  const dir = sweepsIn(t, { tiny: "chatModels: [a, b]\nmemory: [off, on]\n" });
  const loaded = await loadSweep("tiny", {}, dir);
  const again = JSON.parse(resolvedSweepJson(loaded.sweep));
  assert.deepEqual(again, JSON.parse(JSON.stringify(loaded.sweep)));
  assert.equal(new Set(loaded.setups.map(setupId)).size, 4);
});

test("the calibration and head-to-head sweeps run alone, with the judge and a cap, and no Chat", async () => {
  const dir = defaultSweepsDir();
  const calibration = await loadSweep("calibration", {}, dir);
  assert.deepEqual(calibration.sweep.tests, ["calibration"]);
  assert.equal(calibration.sweep.compare, undefined);
  assert.equal(calibration.sweep.judge.model, "moonshotai/kimi-k3.1-pro");
  assert.equal(calibration.sweep.spendingCapUsd, 10);

  const headToHead = await loadSweep("head-to-head", {}, dir);
  assert.deepEqual(headToHead.sweep.tests, ["head-to-head"]);
  assert.equal(headToHead.sweep.compareTop, 3);
  assert.equal(headToHead.sweep.spendingCapUsd, 30);
  const names = availableSweeps(dir);
  assert.ok(names.includes("calibration") && names.includes("head-to-head"));
});

test("--compare names the sweep to read, and wins over the file", async (t) => {
  const dir = sweepsIn(t, {
    fixed: "tests: [ head-to-head ]\ncompare: 2026-11-01T000000Z-old\n",
    open: "tests: [ head-to-head ]\n",
    person: "tests: [ person ]\n",
  });
  const id = "2026-11-10T031500Z-screen";
  assert.equal((await loadSweep("open", {}, dir)).sweep.compare, undefined);
  assert.equal(
    (await loadSweep("open", {}, dir, { compare: id })).sweep.compare,
    id
  );
  assert.equal(
    (await loadSweep("fixed", {}, dir)).sweep.compare,
    "2026-11-01T000000Z-old"
  );
  assert.equal(
    (await loadSweep("fixed", {}, dir, { compare: id })).sweep.compare,
    id
  );
  // A sweep that reads no other sweep refuses a name for one, and says why.
  await assert.rejects(loadSweep("person", {}, dir, { compare: id }), pattern5);
});

test("the resolved JSON carries compare, so every pass reads the same sweep", async (t) => {
  const dir = sweepsIn(t, { open: "tests: [ head-to-head ]\n" });
  const id = "2026-11-10T031500Z-screen";
  const loaded = await loadSweep("open", {}, dir, { compare: id });
  assert.equal(JSON.parse(resolvedSweepJson(loaded.sweep)).compare, id);
});
