import assert from "node:assert/strict";
import test from "node:test";

import type { EveToolPart } from "eve/client";

import {
  toolErrorText,
  toolPartFailed,
  toolPartName,
  toolPartRunning,
} from "./tool-part.ts";

const base = {
  callId: "call_1",
  kind: "tool",
  label: "search_journal",
  name: "search_journal",
  stepIndex: 0,
  type: "tool",
} as const;

const running: EveToolPart = {
  ...base,
  input: { query: "sad" },
  state: "running",
};
const done: EveToolPart = {
  ...base,
  input: { query: "sad" },
  output: [],
  state: "completed",
};
const errored: EveToolPart = {
  ...base,
  error: { code: "tool_failed", message: "  Sage is locked.  " },
  input: { query: "sad" },
  state: "failed",
};
const mcpError: EveToolPart = {
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
  state: "completed",
};

test("toolPartName is eve's name for the tool", () => {
  assert.equal(toolPartName(done), "search_journal");
  assert.equal(
    toolPartName({ ...done, name: "facts__search_memories" }),
    "facts__search_memories"
  );
});

test("a call is running until its result comes back", () => {
  assert.equal(toolPartRunning(running), true);
  assert.equal(
    toolPartRunning({ ...base, inputText: "{", state: "streaming" }),
    true
  );
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
  assert.equal(
    toolErrorText({ ...errored, error: { code: "tool_failed", message: " " } }),
    null
  );
  assert.equal(toolErrorText(done), null);
  assert.equal(toolErrorText(running), null);
});
