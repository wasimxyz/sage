import assert from "node:assert/strict";
import test from "node:test";

import { formatDreamError, ollamaDownDreamMessage } from "./dream-errors.ts";

test("formatDreamError strips the bridge code from a local AI down start error", () => {
  assert.equal(
    formatDreamError(new Error("handler_failed: Local AI is not running.")),
    ollamaDownDreamMessage
  );
});

test("formatDreamError maps a mid-run local AI down message", () => {
  assert.equal(
    formatDreamError("Local AI is not running."),
    ollamaDownDreamMessage
  );
});

test("formatDreamError keeps other Dream messages without the bridge code", () => {
  assert.equal(
    formatDreamError(
      new Error(
        "handler_failed: The summary model is not downloaded. Download qwen3.5:9b in Settings › Models."
      )
    ),
    "The summary model is not downloaded. Download qwen3.5:9b in Settings › Models."
  );
});

test("formatDreamError uses the fallback when the value has no message", () => {
  assert.equal(formatDreamError(null), "Could not start dreaming.");
});
