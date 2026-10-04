import assert from "node:assert/strict";
import test from "node:test";

import { formatDreamError, ollamaDownDreamMessage } from "./dream-errors.ts";

test("formatDreamError strips the bridge code from an Ollama-down start error", () => {
  assert.equal(
    formatDreamError(new Error("handler_failed: Ollama is not running.")),
    ollamaDownDreamMessage
  );
});

test("formatDreamError maps a mid-run Ollama-down message", () => {
  assert.equal(
    formatDreamError("Ollama is not running."),
    ollamaDownDreamMessage
  );
});

test("formatDreamError keeps other Dream messages without the bridge code", () => {
  assert.equal(
    formatDreamError(
      new Error(
        "handler_failed: The summary model is not pulled. Run: ollama pull qwen3.5:9b"
      )
    ),
    "The summary model is not pulled. Run: ollama pull qwen3.5:9b"
  );
});

test("formatDreamError uses the fallback when the value has no message", () => {
  assert.equal(formatDreamError(null), "Could not start dreaming.");
});
