import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENV_SETUP_ID,
  ENV_SWEEP_FILE,
  expandSetups,
  parseSweepFile,
  setupId,
} from "./schema.ts";
import {
  memoryOn,
  readPassSetup,
  readPassSweep,
  setupHeaders,
  thinkHeader,
} from "./setup.ts";

const sageEvalSetupIdPattern =
  /SAGE_EVAL_SETUP_ID is not set, and the sweep has 2 setups/u;
const sageEvalSetupId2Pattern =
  /SAGE_EVAL_SETUP_ID=0000000000 is not a setup of the sweep/u;
const couldNotReadThePattern = /Could not read the sweep file .*sweep\.json/u;
const invalidSweepFileBadPattern =
  /Invalid sweep file .*bad\.json[\s\S]*memory/u;

const notSupportedBySagePattern = /not supported by Sage's Chat/u;

function writeSweep(sweep: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "sage-setup-")), "sweep.json");
  // The runner writes the parsed sweep, so write it the same way.
  writeFileSync(path, JSON.stringify(parseSweepFile(sweep)));
  return path;
}

test("thinkHeader maps on to 1 and off to 0", () => {
  assert.equal(thinkHeader("on"), "1");
  assert.equal(thinkHeader("off"), "0");
});

test("thinkHeader throws on a level Sage's Chat does not take", () => {
  for (const level of ["low", "medium", "high"] as const) {
    assert.throws(() => thinkHeader(level), notSupportedBySagePattern);
  }
});

test("setupHeaders carries the chat model, thinking, and context length", () => {
  const [setup] = expandSetups(
    parseSweepFile({
      chatModels: ["qwen3:8b"],
      contextLengths: [8192],
      thinking: ["on"],
    })
  );
  assert.deepEqual(setupHeaders(setup), {
    "x-sage-context-length": "8192",
    "x-sage-model": "qwen3:8b",
    "x-sage-think": "1",
  });
});

test("readPassSetup picks the setup named by the setup id", () => {
  const sweepPath = writeSweep({
    chatModels: ["qwen3:8b", "gemma3:12b"],
    thinking: ["off", "on"],
  });
  const setups = expandSetups(
    parseSweepFile({
      chatModels: ["qwen3:8b", "gemma3:12b"],
      thinking: ["off", "on"],
    })
  );
  const [, , , wanted] = setups;
  const pass = readPassSetup({
    [ENV_SETUP_ID]: setupId(wanted),
    [ENV_SWEEP_FILE]: sweepPath,
  });
  assert.equal(pass.fromSweep, true);
  assert.deepEqual(pass.setup, wanted);
  assert.equal(pass.setupId, setupId(wanted));
  assert.equal(pass.setup.chatModel, "gemma3:12b");
  assert.equal(pass.setup.thinking, "on");
});

test("readPassSetup reports the repeats of the sweep", () => {
  const sweepPath = writeSweep({ repeats: 3 });
  const pass = readPassSetup({ [ENV_SWEEP_FILE]: sweepPath });
  assert.equal(pass.repeats, 3);
});

test("readPassSetup takes the only setup when no id is set", () => {
  const sweepPath = writeSweep({ chatModels: ["qwen3:8b"] });
  const pass = readPassSetup({ [ENV_SWEEP_FILE]: sweepPath });
  assert.equal(pass.setup.chatModel, "qwen3:8b");
});

test("readPassSetup needs a setup id when the sweep has several setups", () => {
  const sweepPath = writeSweep({ chatModels: ["qwen3:8b", "gemma3:12b"] });
  assert.throws(
    () => readPassSetup({ [ENV_SWEEP_FILE]: sweepPath }),
    sageEvalSetupIdPattern
  );
});

test("readPassSetup rejects a setup id that is not in the sweep", () => {
  const sweepPath = writeSweep({ chatModels: ["qwen3:8b"] });
  assert.throws(
    () =>
      readPassSetup({
        [ENV_SETUP_ID]: "0000000000",
        [ENV_SWEEP_FILE]: sweepPath,
      }),
    sageEvalSetupId2Pattern
  );
});

test("readPassSetup names the sweep file when it cannot be read", () => {
  assert.throws(
    () =>
      readPassSetup({
        [ENV_SWEEP_FILE]: join(tmpdir(), "sage-setup-missing", "sweep.json"),
      }),
    couldNotReadThePattern
  );
});

test("readPassSetup names the sweep file when it is not a valid sweep", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sage-setup-")), "bad.json");
  writeFileSync(path, JSON.stringify({ memory: ["sideways"] }));
  assert.throws(
    () => readPassSetup({ [ENV_SWEEP_FILE]: path }),
    invalidSweepFileBadPattern
  );
});

test("a bare run takes SAGE_CHAT_MODEL, then falls back to the defaults", () => {
  const saved = {
    chat: process.env.SAGE_CHAT_MODEL,
    chats: process.env.SAGE_CHAT_MODELS,
    ollama: process.env.OLLAMA_MODEL,
  };
  process.env.SAGE_CHAT_MODEL = "ollama/llama3.2";
  try {
    const pass = readPassSetup({});
    assert.equal(pass.fromSweep, false);
    assert.equal(pass.setup.chatModel, "llama3.2");
    assert.equal(pass.setup.thinking, "off");
    assert.equal(pass.setup.contextLength, 32_768);
    assert.equal(pass.setup.prompt, "baseline");
    assert.equal(pass.setup.dreamPrompt, "baseline");
    assert.equal(pass.repeats, 1);
    assert.equal(pass.setupId, setupId(pass.setup));
    assert.equal(memoryOn(pass.setup), true);
    assert.deepEqual(setupHeaders(pass.setup), {
      "x-sage-context-length": "32768",
      "x-sage-model": "llama3.2",
      "x-sage-think": "0",
    });
  } finally {
    for (const [key, value] of [
      ["SAGE_CHAT_MODEL", saved.chat],
      ["SAGE_CHAT_MODELS", saved.chats],
      ["OLLAMA_MODEL", saved.ollama],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("a bare run reads the context window and summary model from the environment", () => {
  const pass = readPassSetup({
    OLLAMA_CONTEXT_WINDOW: "16384",
    SAGE_SUMMARY_MODEL: "qwen3:14b",
  });
  assert.equal(pass.setup.contextLength, 16_384);
  assert.equal(pass.setup.summaryModel, "qwen3:14b");
  const ignored = readPassSetup({ OLLAMA_CONTEXT_WINDOW: "lots" });
  assert.equal(ignored.setup.contextLength, 32_768);
});

test("memoryOn follows the memory dimension", () => {
  const [off] = expandSetups(parseSweepFile({ memory: ["off"] }));
  const [on] = expandSetups(parseSweepFile({ memory: ["on"] }));
  assert.equal(memoryOn(off), false);
  assert.equal(memoryOn(on), true);
});

test("readPassSweep reads the sweep without a setup id, and gives defaults without a file", () => {
  const sweepPath = writeSweep({
    chatModels: ["qwen3:8b", "gemma3:12b"],
    spendingCapUsd: 12,
  });
  assert.equal(
    readPassSweep({ [ENV_SWEEP_FILE]: sweepPath }).spendingCapUsd,
    12
  );
  assert.equal(readPassSweep({}).spendingCapUsd, 50);
  assert.equal(readPassSweep({}).judge.model, "moonshotai/kimi-k3.1-pro");
});
