import assert from "node:assert/strict";
import test from "node:test";

import type { EveDynamicToolPart, EveMessagePart } from "eve/client";

import { assistantRuns } from "./assistant-runs.ts";

function tool(toolName: string, id: string): EveDynamicToolPart {
  return {
    input: {},
    output: {},
    state: "output-available",
    toolCallId: id,
    toolName,
    type: "dynamic-tool",
  };
}

const read = (id: string) => tool("get_journal_entry", id);
const search = (id: string) => tool("search_journal", id);
const thinking = (text: string): EveMessagePart => ({
  state: "done",
  text,
  type: "reasoning",
});
const reply: EveMessagePart = { state: "done", text: "Here.", type: "text" };

function kinds(parts: readonly EveMessagePart[]): string[] {
  return assistantRuns(parts).map((run) => run.kind);
}

test("reads with nothing between them become one run", () => {
  const runs = assistantRuns([read("a"), read("b"), read("c")]);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run?.kind, "reads");
  assert.deepEqual(
    run?.kind === "reads" ? run.parts.map((part) => part.toolCallId) : [],
    ["a", "b", "c"]
  );
});

test("a single read is a run of one", () => {
  assert.deepEqual(kinds([read("a")]), ["reads"]);
});

test("thinking or text between reads starts a new run", () => {
  assert.deepEqual(kinds([read("a"), thinking("Hmm."), read("b")]), [
    "reads",
    "reasoning",
    "reads",
  ]);
  assert.deepEqual(kinds([read("a"), reply, read("b")]), [
    "reads",
    "part",
    "reads",
  ]);
});

test("another tool between reads starts a new run", () => {
  assert.deepEqual(kinds([read("a"), search("s"), read("b")]), [
    "reads",
    "part",
    "reads",
  ]);
});

test("parts that show nothing do not split a run of reads", () => {
  assert.deepEqual(
    kinds([
      read("a"),
      { type: "step-start" },
      { state: "done", text: "  ", type: "reasoning" },
      { state: "done", text: "", type: "text" },
      read("b"),
    ]),
    ["reads"]
  );
});

test("consecutive thinking parts become one run", () => {
  const runs = assistantRuns([thinking("One."), thinking("Two.")]);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual(run?.kind === "reasoning" ? run.texts : [], [
    "One.",
    "Two.",
  ]);
});

test("a thinking run follows its last part while it streams", () => {
  const [run] = assistantRuns([
    thinking("One."),
    { state: "streaming", text: "Two.", type: "reasoning" },
  ]);
  assert.equal(run?.kind === "reasoning" && run.streaming, true);
});

test("a step start between thinking parts ends the thinking run", () => {
  assert.deepEqual(
    kinds([thinking("One."), { type: "step-start" }, thinking("Two.")]),
    ["reasoning", "reasoning"]
  );
});

test("a search and a reply each keep their own run, in order", () => {
  const runs = assistantRuns([thinking("Hmm."), search("s"), reply]);
  assert.deepEqual(
    runs.map((run) => run.kind),
    ["reasoning", "part", "part"]
  );
  assert.deepEqual(
    runs.map((run) => (run.kind === "part" ? run.index : -1)),
    [-1, 1, 2]
  );
});
