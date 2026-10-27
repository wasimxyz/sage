import assert from "node:assert/strict";
import test from "node:test";

import type { EveDynamicToolPart } from "eve/client";

import {
  toolErrorText,
  toolPartFailed,
  toolPartName,
  toolPartRunning,
} from "./tool-part.ts";

const base = { toolCallId: "call_1", toolName: "search_journal" } as const;

const running: EveDynamicToolPart = {
  ...base,
  input: { query: "sad" },
  state: "input-available",
  type: "dynamic-tool",
};
const done: EveDynamicToolPart = {
  ...base,
  input: { query: "sad" },
  output: [],
  state: "output-available",
  type: "dynamic-tool",
};
const errored: EveDynamicToolPart = {
  ...base,
  errorText: "  Sage is locked.  ",
  input: { query: "sad" },
  state: "output-error",
  type: "dynamic-tool",
};
const mcpError: EveDynamicToolPart = {
  ...base,
  input: {},
  output: {
    content: [
      { text: "First line.", type: "text" },
      { type: "image" },
      { text: "Second line.", type: "text" },
    ],
    isError: true,
  },
  state: "output-available",
  type: "dynamic-tool",
};

test("toolPartName prefers eve's name for the tool", () => {
  assert.equal(toolPartName(done), "search_journal");
  assert.equal(
    toolPartName({
      ...done,
      toolMetadata: { eve: { kind: "tool", name: "facts__search_memories" } },
    } as EveDynamicToolPart),
    "facts__search_memories"
  );
});

test("a call is running until its result comes back", () => {
  assert.equal(toolPartRunning(running), true);
  assert.equal(toolPartRunning(done), false);
  assert.equal(toolPartRunning(errored), false);
});

test("a call failed when it errored or came back as an MCP error", () => {
  assert.equal(toolPartFailed(errored), true);
  assert.equal(toolPartFailed(mcpError), true);
  assert.equal(toolPartFailed(done), false);
  assert.equal(toolPartFailed(running), false);
});

test("the error text of a failed call is plain text", () => {
  assert.equal(toolErrorText(errored), "Sage is locked.");
  assert.equal(toolErrorText(mcpError), "First line.\nSecond line.");
  assert.equal(toolErrorText({ ...errored, errorText: " " }), null);
  assert.equal(toolErrorText(done), null);
  assert.equal(toolErrorText(running), null);
});
