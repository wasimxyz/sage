import assert from "node:assert/strict";
import test from "node:test";

import { ollamaDownTidyMessage, tidyFailure } from "./tidy-errors.ts";

test("a local AI that is down says so and offers to start it", () => {
  assert.deepEqual(
    tidyFailure(new Error("handler_failed: Local AI is not running.")),
    { message: ollamaDownTidyMessage, startLocalAi: true }
  );
  assert.deepEqual(tidyFailure("Local AI is not running."), {
    message: ollamaDownTidyMessage,
    startLocalAi: true,
  });
});

test("other sentences from the core are kept without the bridge code", () => {
  assert.deepEqual(
    tidyFailure(new Error("handler_failed: Select less text to tidy.")),
    { message: "Select less text to tidy.", startLocalAi: false }
  );
  assert.deepEqual(
    tidyFailure(
      new Error(
        "handler_failed: Tidy would have changed your words, so Sage left them as they were."
      )
    ),
    {
      message:
        "Tidy would have changed your words, so Sage left them as they were.",
      startLocalAi: false,
    }
  );
});

test("a model that is not downloaded keeps the core's sentence and offers no start", () => {
  const message =
    "The summary model is not downloaded. Download qwen3.5:9b in Settings › Models.";
  assert.deepEqual(tidyFailure(new Error(`handler_failed: ${message}`)), {
    message,
    startLocalAi: false,
  });
});

test("a locked app says so", () => {
  assert.deepEqual(tidyFailure(new Error("handler_failed: Sage is locked.")), {
    message: "Sage is locked.",
    startLocalAi: false,
  });
});

test("a local AI that is too slow keeps the core's sentence and offers no start", () => {
  assert.deepEqual(
    tidyFailure(new Error("handler_failed: Local AI did not answer in time.")),
    { message: "Local AI did not answer in time.", startLocalAi: false }
  );
});

test("an error with no message falls back", () => {
  assert.deepEqual(tidyFailure(null), {
    message: "Could not tidy the text.",
    startLocalAi: false,
  });
  assert.deepEqual(tidyFailure(new Error("handler_failed: ")), {
    message: "Could not tidy the text.",
    startLocalAi: false,
  });
});
