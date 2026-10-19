import assert from "node:assert/strict";
import test from "node:test";

import type { ChatLoadPromise } from "./load-conversation.ts";
import { keepsOpenPane } from "./open-chat.ts";

function load(
  status: "fulfilled" | "pending",
  kind?: "failed" | "ready"
): ChatLoadPromise {
  const promise = Promise.resolve() as unknown as Record<string, unknown>;
  promise.status = status;
  if (status === "fulfilled") {
    promise.value = { kind };
  }
  return promise as unknown as ChatLoadPromise;
}

test("opening the chat that is open keeps its pane", () => {
  const selection = {
    id: 7,
    kind: "saved",
    load: load("fulfilled", "ready"),
  } as const;
  assert.equal(keepsOpenPane(selection, 7), true);
});

test("opening the chat that is open while it still loads keeps its pane", () => {
  const selection = { id: 7, kind: "saved", load: load("pending") } as const;
  assert.equal(keepsOpenPane(selection, 7), true);
});

test("opening a different chat makes a new pane", () => {
  const selection = {
    id: 7,
    kind: "saved",
    load: load("fulfilled", "ready"),
  } as const;
  assert.equal(keepsOpenPane(selection, 8), false);
});

test("opening a chat from a new chat makes a new pane", () => {
  const selection = { kind: "new", load: load("fulfilled", "ready") } as const;
  assert.equal(keepsOpenPane(selection, 7), false);
});

test("opening a chat whose read failed reads it again", () => {
  const selection = {
    id: 7,
    kind: "saved",
    load: load("fulfilled", "failed"),
  } as const;
  assert.equal(keepsOpenPane(selection, 7), false);
});
