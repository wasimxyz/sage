import assert from "node:assert/strict";
import test from "node:test";

import {
  handlerErrorMessage,
  isTooManyAttempts,
  rawHandlerError,
} from "./handler-errors.ts";

test("handlerErrorMessage drops the handler_failed code", () => {
  assert.equal(
    handlerErrorMessage(
      new Error("handler_failed: Ollama did not start in time.")
    ),
    "Ollama did not start in time."
  );
});

test("handlerErrorMessage preserves the Touch ID Keychain fallback", () => {
  assert.equal(
    handlerErrorMessage(
      new Error(
        "handler_failed: Could not read the journal key. Use your password."
      )
    ),
    "Could not read the journal key. Use your password."
  );
});

test("handlerErrorMessage keeps a message that has no code", () => {
  assert.equal(
    handlerErrorMessage(new Error("Ollama is locked.")),
    "Ollama is locked."
  );
});

test("handlerErrorMessage reads a thrown string", () => {
  assert.equal(handlerErrorMessage("handler_failed: Nope."), "Nope.");
});

test("handlerErrorMessage returns nothing for a value with no message", () => {
  assert.equal(handlerErrorMessage(null), "");
  assert.equal(handlerErrorMessage(undefined), "");
  assert.equal(handlerErrorMessage({ code: "handler_failed" }), "");
});

test("rawHandlerError reads both a string and an Error", () => {
  assert.equal(rawHandlerError("plain"), "plain");
  assert.equal(rawHandlerError(new Error("wrapped")), "wrapped");
  assert.equal(rawHandlerError(42), "");
});

test("isTooManyAttempts matches only the native wait refusal", () => {
  assert.equal(
    isTooManyAttempts(new Error("handler_failed: TooManyAttempts")),
    true
  );
  assert.equal(isTooManyAttempts("TooManyAttempts"), true);
  assert.equal(isTooManyAttempts(new Error("WrongPassword")), false);
  assert.equal(isTooManyAttempts(null), false);
});
