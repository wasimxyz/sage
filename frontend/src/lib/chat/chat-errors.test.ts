import assert from "node:assert/strict";
import test from "node:test";

import { formatChatSaveError, formatChatSendError } from "./chat-errors.ts";

const downMessage = "The Chat agent isn't running.";

test("formatChatSendError maps a connection failure to the down copy", () => {
  assert.equal(
    formatChatSendError(
      new Error("connect ECONNREFUSED 127.0.0.1:2001"),
      downMessage
    ),
    downMessage
  );
});

test("formatChatSendError maps bridge lock and missing-row errors", () => {
  assert.equal(
    formatChatSendError(new Error("handler_failed: Locked"), downMessage),
    "Unlock the app first."
  );
  assert.equal(
    formatChatSendError(new Error("handler_failed: NotFound"), downMessage),
    "This chat could not be found."
  );
});

test("formatChatSendError does not expose other host or provider messages", () => {
  assert.equal(
    formatChatSendError(
      new Error("connect ETIMEDOUT 127.0.0.1:2001 with private details"),
      downMessage
    ),
    downMessage
  );
  assert.equal(
    formatChatSendError(
      new Error("provider details and private paths"),
      downMessage
    ),
    "Could not send the message."
  );
});

test("formatChatSaveError maps known errors and hides unknown messages", () => {
  assert.equal(
    formatChatSaveError(new Error("handler_failed: Locked")),
    "Unlock the app first."
  );
  assert.equal(
    formatChatSaveError(new Error("connect ECONNREFUSED /private/path")),
    "Could not save the chat."
  );
});
