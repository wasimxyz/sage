/**
 * Turns the variables the runner sets for one `eve eval` pass into the setup
 * that pass tests, and the headers that tell Sage's Chat agent to run it.
 *
 * The runner writes the parsed sweep file as JSON and sets
 * `SAGE_EVAL_SWEEP_FILE` to its path and `SAGE_EVAL_SETUP_ID` to one of the
 * setups it expands to. A bare `eve eval` with neither variable falls back to
 * the environment, the way the suite always did: `SAGE_CHAT_MODEL` picks the
 * chat model and everything else is a default.
 *
 * Reading the environment is cheap and never starts a model, because eve
 * imports every eval file before it filters them.
 */
import { readFileSync } from "node:fs";

import { chatModel, embedModel } from "./models.ts";
import {
  BASELINE_PROMPT,
  DEFAULT_SUMMARY_MODEL,
  ENV_SETUP_ID,
  ENV_SWEEP_FILE,
  expandSetups,
  parseSweepFile,
  readPassEnv,
  type Setup,
  type SweepFile,
  setupId,
  type Thinking,
} from "./schema.ts";

export const HEADER_MODEL = "x-sage-model";
export const HEADER_THINK = "x-sage-think";
export const HEADER_CONTEXT_LENGTH = "x-sage-context-length";

/** What Sage's Chat agent uses when no header names a context length. */
const DEFAULT_CONTEXT_LENGTH = 32_768;
const WHOLE_NUMBER = /^[1-9]\d*$/u;

export interface PassSetup {
  /** False for a bare `eve eval` that read no sweep file. */
  fromSweep: boolean;
  /** How many times each Chat item runs. */
  repeats: number;
  setup: Setup;
  /** The 10-character id the reports use. */
  setupId: string;
  sweep: SweepFile;
}

/**
 * The value for `x-sage-think`. Sage's Chat agent takes thinking on or off,
 * so the levels in a sweep file (`low`, `medium`, `high`) are not supported
 * yet and stop the pass instead of quietly running something else.
 */
export function thinkHeader(thinking: Thinking): "0" | "1" {
  if (thinking === "on") {
    return "1";
  }
  if (thinking === "off") {
    return "0";
  }
  throw new Error(
    `Thinking "${thinking}" is not supported by Sage's Chat yet. Use "on" or "off".`
  );
}

/**
 * The headers that select this setup in Sage's Chat agent. Send them with
 * every turn: eve drops them between turns of one session.
 */
export function setupHeaders(setup: Setup): Record<string, string> {
  return {
    [HEADER_CONTEXT_LENGTH]: String(setup.contextLength),
    [HEADER_MODEL]: setup.chatModel,
    [HEADER_THINK]: thinkHeader(setup.thinking),
  };
}

/** True when the setup builds Sage with Dream's memory on. */
export function memoryOn(setup: Setup): boolean {
  return setup.memory === "on";
}

type Env = Readonly<Record<string, string | undefined>>;

function contextLengthFrom(env: Env): number {
  const raw = env.OLLAMA_CONTEXT_WINDOW?.trim();
  return raw !== undefined && WHOLE_NUMBER.test(raw)
    ? Number(raw)
    : DEFAULT_CONTEXT_LENGTH;
}

/**
 * The setup of a bare `eve eval`. Memory is on because the memory checks ran
 * before sweeps existed, and a bare run has no sweep to say otherwise.
 */
function bareSetup(env: Env): Setup {
  const summaryModel = env.SAGE_SUMMARY_MODEL?.trim();
  return {
    chatModel: chatModel(),
    contextLength: contextLengthFrom(env),
    dreamPrompt: BASELINE_PROMPT,
    embedModel: embedModel(),
    memory: "on",
    prompt: BASELINE_PROMPT,
    summaryModel:
      summaryModel === undefined || summaryModel.length === 0
        ? DEFAULT_SUMMARY_MODEL
        : summaryModel,
    thinking: "off",
  };
}

function readSweepFile(path: string): SweepFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read the sweep file ${path} (${ENV_SWEEP_FILE}): ${reason}`,
      { cause: error }
    );
  }
  return parseSweepFile(json, `sweep file ${path}`);
}

function pickSetup(sweep: SweepFile, wanted: string | undefined): Setup {
  const setups = expandSetups(sweep);
  if (wanted === undefined) {
    const [only] = setups;
    if (setups.length === 1 && only !== undefined) {
      return only;
    }
    throw new Error(
      `${ENV_SETUP_ID} is not set, and the sweep has ${setups.length} setups. Set it to one of: ${setups.map((setup) => setupId(setup)).join(", ")}.`
    );
  }
  const found = setups.find((setup) => setupId(setup) === wanted);
  if (found === undefined) {
    throw new Error(
      `${ENV_SETUP_ID}=${wanted} is not a setup of the sweep. Known: ${setups.map((setup) => setupId(setup)).join(", ")}.`
    );
  }
  return found;
}

/**
 * The sweep file this pass belongs to, with its defaults filled in. A bare
 * `eve eval` has no sweep file and gets all the defaults. It does not need a
 * setup id, so judge settings and the spending cap can be read on their own.
 */
export function readPassSweep(env: Env = process.env): SweepFile {
  const { sweepFile } = readPassEnv(env);
  return sweepFile === undefined
    ? parseSweepFile({}, "default sweep")
    : readSweepFile(sweepFile);
}

/**
 * The setup this pass tests. Throws a readable error when the sweep file is
 * unreadable or invalid, or when the setup id is not one of its setups.
 */
export function readPassSetup(env: Env = process.env): PassSetup {
  const pass = readPassEnv(env);
  if (pass.sweepFile === undefined) {
    const setup = bareSetup(env);
    return {
      fromSweep: false,
      repeats: 1,
      setup,
      setupId: pass.setupId ?? setupId(setup),
      sweep: readPassSweep(env),
    };
  }
  const sweep = readPassSweep(env);
  const setup = pickSetup(sweep, pass.setupId);
  return {
    fromSweep: true,
    repeats: sweep.repeats,
    setup,
    setupId: setupId(setup),
    sweep,
  };
}
