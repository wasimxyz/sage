import assert from "node:assert/strict";
import test from "node:test";

import { displayModelName, parseRunId, runIdFromPathname } from "./run-id.ts";

test("parseRunId reads a trio filename", () => {
  const parsed = parseRunId(
    "qwen3_14b__nomic-embed-text__llama3.1_8b__20260916T061948Z"
  );
  assert.equal(parsed.dreamModel, "qwen3:14b");
  assert.equal(parsed.embedModel, "nomic-embed-text");
  assert.equal(parsed.chatModel, "llama3.1:8b");
  assert.equal(parsed.startedAt, "2026-09-16T06:19:48Z");
});

test("parseRunId treats a two-model filename as legacy dream+embed", () => {
  const parsed = parseRunId("qwen3_14b__nomic-embed-text__20260916T061948Z");
  assert.equal(parsed.dreamModel, "qwen3:14b");
  assert.equal(parsed.embedModel, "nomic-embed-text");
  assert.equal(parsed.chatModel, "qwen3:14b");
});

test("runIdFromPathname strips report suffixes", () => {
  assert.equal(
    runIdFromPathname(
      "sage-evals/qwen3_8b__nomic-embed-text__20260916T011701Z.xml"
    ),
    "qwen3_8b__nomic-embed-text__20260916T011701Z"
  );
  assert.equal(runIdFromPathname("run.sage.log"), "run");
  assert.equal(runIdFromPathname("run.manifest.json"), "run");
});

test("displayModelName restores the ollama tag colon", () => {
  assert.equal(displayModelName("qwen3_8b"), "qwen3:8b");
  assert.equal(displayModelName("nomic-embed-text"), "nomic-embed-text");
});
