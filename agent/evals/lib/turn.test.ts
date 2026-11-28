import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { EveEvalTurn } from "eve/evals";

import { expandSetups, parseSweepFile, type Setup } from "./schema.ts";
import {
  checkTurnWorks,
  measureTurn,
  sendTurn,
  type TimedEvent,
  type TurnSender,
  toTranscriptToolCalls,
  turnWorksStatus,
} from "./turn.ts";

const notSupportedPattern = /not supported/u;

const BASE = Date.parse("2026-11-09T10:00:00.000Z");

function event(
  type: string,
  offsetMs: number,
  data: Record<string, unknown> = {}
): TimedEvent {
  return {
    data,
    meta: { at: new Date(BASE + offsetMs).toISOString() },
    type,
  };
}

const received = (offsetMs: number, text = "Hi Sage") =>
  event("delivery.consumed", offsetMs, {
    parts: [{ kind: "text", text }],
  });
const answered = (offsetMs: number) =>
  event("delivery.consumed", offsetMs, { parts: [] });
const delta = (offsetMs: number, value = "Hel", partId = "p", kind?: string) =>
  event("content.delta", offsetMs, {
    delta: value,
    partId,
    ...(kind === undefined ? {} : { kind }),
  });
const stored = (
  offsetMs: number,
  value: string,
  phase = "reply",
  partId = "p"
) =>
  event("content.completed", offsetMs, { kind: "text", partId, phase, value });
const reasoning = (offsetMs: number, partId = "r") =>
  event("content.completed", offsetMs, {
    kind: "reasoning",
    partId,
    value: "hmm",
  });
const modelStarted = (offsetMs: number, modelId: string) =>
  event("model.started", offsetMs, { attempt: 0, modelId });
const requested = (offsetMs: number, callId: string) =>
  event("call.requested", offsetMs, { callId });
const settled = (offsetMs: number, callId: string) =>
  event("call.settled", offsetMs, { callId, outcome: "completed" });

test("first visible time runs from delivery.consumed to the first non-blank text delta", () => {
  const { timing } = measureTurn([
    event("turn.started", 0),
    received(10),
    modelStarted(20, "qwen3:8b"),
    delta(300, "Thinking", "r", "reasoning"),
    reasoning(900),
    delta(900, "   ", "p", "text"),
    delta(1500, "Hello", "p"),
    stored(1800, "Hello there"),
    event("turn.settled", 2500, { outcome: "completed" }),
    event("delivery.settled", 2600),
  ]);
  // The delta with no kind is text: its part completes as text.
  assert.equal(timing.firstVisibleMs, 1490);
  assert.equal(timing.totalMs, 2590);
});

test("a model that does not stream is timed from its stored text", () => {
  const { timing } = measureTurn([
    received(0),
    stored(4000, "All at once."),
    event("turn.settled", 4100),
  ]);
  assert.equal(timing.firstVisibleMs, 4000);
});

test("reasoning does not count as visible text", () => {
  const { timing } = measureTurn([
    received(0),
    reasoning(100),
    reasoning(200),
    event("turn.settled", 5000),
  ]);
  assert.equal(timing.firstVisibleMs, null);
  assert.equal(timing.totalMs, 5000);
});

test("text before a tool call is visible text", () => {
  const { timing } = measureTurn([
    received(0),
    stored(400, "Let me look.", "narration"),
    requested(450, "a"),
    settled(900, "a"),
    stored(4000, "Found it."),
  ]);
  assert.equal(timing.firstVisibleMs, 400);
});

test("tool time counts overlapping calls once", () => {
  const { timing } = measureTurn([
    received(0),
    requested(1000, "a"),
    requested(1000, "b"),
    settled(1500, "a"),
    settled(2200, "b"),
    modelStarted(2300, "m"),
    requested(3000, "c"),
    settled(3400, "c"),
    stored(3500, "Done"),
    event("turn.settled", 3600),
  ]);
  // a and b cover 1000 to 2200, c covers 3000 to 3400.
  assert.equal(timing.toolMs, 1200 + 400);
});

test("a tool call that never settled adds no tool time", () => {
  const { timing } = measureTurn([
    received(0),
    requested(100, "a"),
    event("turn.settled", 900, { outcome: "failed" }),
  ]);
  assert.equal(timing.toolMs, 0);
});

test("model ids list every model attempt in order", () => {
  const { stepModelIds } = measureTurn([
    received(0),
    modelStarted(10, "qwen3:8b"),
    requested(20, "a"),
    settled(30, "a"),
    modelStarted(40, "qwen3:8b"),
    stored(50, "Hi"),
  ]);
  assert.deepEqual(stepModelIds, ["qwen3:8b", "qwen3:8b"]);
});

test("only the last turn of a session is measured", () => {
  const { stepModelIds, timing } = measureTurn([
    received(0),
    modelStarted(10, "first"),
    stored(500, "One"),
    event("turn.settled", 600),
    received(10_000),
    modelStarted(10_010, "second"),
    // An answer to a question takes in no text, so the turn goes on.
    answered(10_100),
    stored(10_200, "Two"),
    event("turn.settled", 10_300),
  ]);
  assert.deepEqual(stepModelIds, ["second"]);
  assert.equal(timing.firstVisibleMs, 200);
  assert.equal(timing.totalMs, 300);
});

test("events without a usable time are skipped, and no events time as zero", () => {
  assert.deepEqual(measureTurn([]).timing, {
    firstVisibleMs: null,
    toolMs: 0,
    totalMs: 0,
  });
  const { timing } = measureTurn([
    received(0),
    {
      data: { kind: "text", value: "Hi" },
      meta: { at: "not a time" },
      type: "content.completed",
    },
    stored(700, "Hello"),
    event("turn.settled", 800),
  ]);
  assert.equal(timing.firstVisibleMs, 700);
});

// ---------------------------------------------------------------------------
// sendTurn
// ---------------------------------------------------------------------------

function setupOf(overrides: Record<string, unknown> = {}): Setup {
  const [setup] = expandSetups(
    parseSweepFile({
      chatModels: ["qwen3:8b"],
      contextLengths: [16_384],
      thinking: ["off"],
      ...overrides,
    })
  );
  return setup;
}

function fakeTurn(events: TimedEvent[]): EveEvalTurn {
  const turn = { events, reply: "Hello", status: "completed" };
  return { ...turn, session: undefined } as unknown as EveEvalTurn;
}

function recordingSender(events: TimedEvent[]) {
  const calls: { options: unknown; text: unknown }[] = [];
  const sender: TurnSender = {
    send(text, options) {
      calls.push({ options, text });
      return Promise.resolve(fakeTurn(events));
    },
  };
  return { calls, sender };
}

test("sendTurn passes the x-sage headers and returns the turn with its timing", async () => {
  const { calls, sender } = recordingSender([
    received(0),
    modelStarted(5, "qwen3:8b"),
    stored(250, "Hi"),
    event("turn.settled", 400),
  ]);
  const sent = await sendTurn(sender, "How was June?", setupOf());
  assert.deepEqual(calls, [
    {
      options: {
        headers: {
          "x-sage-context-length": "16384",
          "x-sage-model": "qwen3:8b",
          "x-sage-think": "0",
        },
      },
      text: "How was June?",
    },
  ]);
  assert.equal(sent.timing.firstVisibleMs, 250);
  assert.deepEqual(sent.stepModelIds, ["qwen3:8b"]);
  assert.equal(sent.turn.reply, "Hello");
});

test("sendTurn passes the headers on every turn of a session, not only the first", async () => {
  const { calls, sender } = recordingSender([received(0), stored(10, "Hi")]);
  const setup = setupOf({ thinking: ["on"] });
  await sendTurn(sender, "first", setup);
  await sendTurn(sender, "second", setup);
  await sendTurn(sender, "third", setup);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.options, {
      headers: {
        "x-sage-context-length": "16384",
        "x-sage-model": "qwen3:8b",
        "x-sage-think": "1",
      },
    });
  }
});

test("sendTurn sends nothing when the thinking value is not supported", async () => {
  const { calls, sender } = recordingSender([]);
  await assert.rejects(
    sendTurn(sender, "hi", setupOf({ thinking: ["high"] })),
    notSupportedPattern
  );
  assert.equal(calls.length, 0);
});

test("toTranscriptToolCalls keeps the name, input, output, and status", () => {
  const calls = toTranscriptToolCalls([
    {
      callId: "a",
      input: { query: "June" },
      name: "search_journal",
      output: { entries: [] },
      status: "completed",
      turnIndex: 0,
    },
    {
      callId: "b",
      input: {},
      name: "get_chat",
      output: undefined,
      status: "pending",
      turnIndex: 0,
    },
    {
      callId: "c",
      input: {},
      name: "get_chat",
      output: undefined,
      status: "interrupted",
      turnIndex: 0,
    },
  ]);
  assert.deepEqual(calls, [
    {
      input: { query: "June" },
      name: "search_journal",
      output: { entries: [] },
      status: "completed",
    },
    { input: {}, name: "get_chat", status: "pending" },
    { input: {}, name: "get_chat", status: "failed" },
  ]);
});

test("turnWorksStatus reads eve's request status", () => {
  assert.equal(turnWorksStatus("completed"), "completed");
  assert.equal(turnWorksStatus("awaiting-input"), "waiting");
  assert.equal(turnWorksStatus("failed"), "failed");
  assert.equal(turnWorksStatus("cancelled"), "failed");
  assert.equal(turnWorksStatus("working"), "failed");
  assert.equal(turnWorksStatus(undefined), "failed");
});

// ---------------------------------------------------------------------------
// checkTurnWorks
// ---------------------------------------------------------------------------

function works(overrides: Partial<Parameters<typeof checkTurnWorks>[0]> = {}) {
  return checkTurnWorks({
    chatModel: "qwen3:8b",
    replyText: "That sounds like a lot.",
    status: "waiting",
    stepModelIds: ["qwen3:8b"],
    ...overrides,
  });
}

test("checkTurnWorks passes a finished turn on the right model", () => {
  assert.deepEqual(works(), { pass: true, problems: [] });
  assert.equal(works({ status: "completed" }).pass, true);
});

test("checkTurnWorks fails a failed turn without also calling its reply empty", () => {
  const checked = works({ replyText: "", status: "failed" });
  assert.equal(checked.pass, false);
  assert.deepEqual(checked.problems, ["the turn failed"]);
});

test("checkTurnWorks fails a turn parked on input", () => {
  assert.equal(works({ parkedOnInput: true }).pass, false);
});

test("checkTurnWorks fails an empty or blank reply", () => {
  assert.deepEqual(works({ replyText: "  \n" }).problems, [
    "the reply is empty",
  ]);
});

test("checkTurnWorks fails a reply that leaks a think tag", () => {
  for (const reply of [
    "<think>The user is sad.</think> Hello.",
    "Hello. </think>",
    "<THINK>x",
  ]) {
    assert.deepEqual(works({ replyText: reply }).problems, [
      "the reply leaks a <think> tag",
    ]);
  }
});

test("checkTurnWorks fails a reply that leaks tool-call syntax", () => {
  for (const reply of [
    '<tool_call>{"name": "search_journal"}</tool_call>',
    '{"name": "search_journal", "arguments": {"query": "June"}}',
    "<function=search_journal>",
    "[TOOL_CALLS] search",
    "<|python_tag|>search_journal",
  ]) {
    assert.deepEqual(
      works({ replyText: reply }).problems,
      ["the reply leaks tool-call syntax"],
      reply
    );
  }
});

test("checkTurnWorks fails a reply that leaks the tool-call tokens of lfm2.5 and gpt-oss", () => {
  for (const reply of [
    '<|tool_call_start|>[search_journal(query="rent")]<|tool_call_end|>',
    'I will look. <|tool_call_start|>[search_journal(query="rent")]',
    '<|channel|>commentary to=functions.search_journal <|constrain|>json<|message|>{"query":"rent"}<|call|>',
    "<|start|>assistant<|channel|>analysis<|message|>The user asks about rent.",
    "commentary to=functions.search_journal",
    "Sure.<|im_end|>",
    "<|eot_id|>",
  ]) {
    assert.deepEqual(
      works({ replyText: reply }).problems,
      ["the reply leaks tool-call syntax"],
      reply
    );
  }
});

test("checkTurnWorks leaves writing about functions and bars alone", () => {
  for (const reply of [
    "Functions of rest: recovery, and a chance to think. I'll go back to functions.",
    "I want to go back to writing functions at work, but not yet.",
    "Rent | Food | Savings\n--- | --- | ---\n1200 | 400 | 300",
    "Pick one | the other | neither.",
    "x <| y is not a thing we say, and neither is a |> b.",
    "Her note said <|3 and she laughed, then wrote |> at the end.",
    "Is 3 < 5 | 4 > 2 true? You asked about <b>bold</b> text.",
    "Two options: <a|b>. Either one works.",
    "The to=functions idea, with no dot, is just a phrase.",
  ]) {
    assert.deepEqual(works({ replyText: reply }).problems, [], reply);
  }
});

test("checkTurnWorks leaves ordinary writing about names and quotes alone", () => {
  assert.equal(
    works({
      replyText:
        "You wrote \"name\": that you'd call it Sam. I'm thinking about what you said, and a function of rest is recovery.",
    }).pass,
    true
  );
});

test("checkTurnWorks fails when a step ran a different model", () => {
  const checked = works({ stepModelIds: ["qwen3:8b", "gemma3:12b"] });
  assert.equal(checked.pass, false);
  assert.deepEqual(checked.problems, [
    "the setup asked for qwen3:8b but a step ran gemma3:12b",
  ]);
});

test("checkTurnWorks ignores an ollama/ prefix on either side", () => {
  assert.equal(
    works({ chatModel: "ollama/qwen3:8b", stepModelIds: ["qwen3:8b"] }).pass,
    true
  );
  assert.equal(
    works({ chatModel: "qwen3:8b", stepModelIds: ["ollama/qwen3:8b"] }).pass,
    true
  );
});

test("checkTurnWorks cannot judge the model when no step was seen", () => {
  assert.equal(works({ stepModelIds: [] }).pass, true);
});

test("checkTurnWorks lists every problem", () => {
  const checked = works({
    replyText: "<think>x</think>",
    stepModelIds: ["other"],
  });
  assert.equal(checked.problems.length, 2);
});

// ---------------------------------------------------------------------------
// No eval file sends a turn by hand
// ---------------------------------------------------------------------------

const evalsDir = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRS = new Set(["data", "node_modules", ".cache", "reports"]);
const SEND_CALL = /\.send(?:File)?\s*\(/u;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//gu;
const LINE_COMMENT = /^\s*\/\/.*$/gmu;

function evalFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!(SKIPPED_DIRS.has(entry.name) || entry.name.startsWith("."))) {
        files.push(...evalFiles(join(dir, entry.name)));
      }
    } else if (entry.name.endsWith(".eval.ts")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

test("no *.eval.ts file calls send directly, because only sendTurn adds the headers", () => {
  const files = evalFiles(evalsDir);
  assert.ok(files.length > 0, "found no eval files to check");
  const offenders = files.filter((file) => {
    const source = readFileSync(file, "utf8")
      .replace(BLOCK_COMMENT, "")
      .replace(LINE_COMMENT, "");
    return SEND_CALL.test(source);
  });
  assert.deepEqual(
    offenders.map((file) => file.slice(evalsDir.length)),
    [],
    "Use sendTurn from lib/turn.ts instead of .send( in an eval file."
  );
});
