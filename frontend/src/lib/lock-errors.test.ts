import assert from "node:assert/strict";
import test from "node:test";

import {
  lockErrorMessage,
  minPasswordLength,
  recoveryUnlockMessage,
} from "./lock-errors.ts";

const fallback = "Could not do that.";
const startAgain = /Start again/;
const tooManyAttempts = /Too many attempts/;

test("lockErrorMessage names the failures people can fix", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["handler_failed: WrongPassword", "The current password is wrong."],
    ["handler_failed: CurrentPasswordRequired", "Enter your current password."],
    [
      "handler_failed: PasswordRequired",
      "Turn on Touch ID or set a password first.",
    ],
    ["handler_failed: WrongRecoveryKey", "That recovery key is wrong."],
    [
      "handler_failed: InvalidRecoveryKey",
      "A recovery key has 24 letters and numbers.",
    ],
    [
      "handler_failed: RecoveryKeyUnavailable",
      "This journal has no recovery key.",
    ],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(lockErrorMessage(new Error(raw), fallback), expected);
  }
});

test("lockErrorMessage tells a stale recovery key from a wrong one", () => {
  const stale = lockErrorMessage(new Error("RecoveryKeyMismatch"), fallback);
  const unissued = lockErrorMessage(new Error("RecoveryKeyRequired"), fallback);
  assert.match(stale, startAgain);
  assert.match(unissued, startAgain);
  assert.notEqual(
    stale,
    lockErrorMessage(new Error("WrongRecoveryKey"), fallback)
  );
});

test("lockErrorMessage reports the wait and the password minimum", () => {
  assert.match(
    lockErrorMessage(new Error("handler_failed: TooManyAttempts"), fallback),
    tooManyAttempts
  );
  assert.equal(
    lockErrorMessage(new Error("PasswordTooShort"), fallback),
    `Use at least ${minPasswordLength} characters.`
  );
});

test("lockErrorMessage falls back for anything else", () => {
  assert.equal(
    lockErrorMessage(new Error("SqliteWriteFailed"), fallback),
    fallback
  );
  assert.equal(lockErrorMessage("WrongPassword", fallback), fallback);
  assert.equal(lockErrorMessage(null, fallback), fallback);
});

test("recoveryUnlockMessage blames the key only when the key is wrong", () => {
  assert.equal(
    recoveryUnlockMessage(new Error("handler_failed: WrongRecoveryKey")),
    "Wrong recovery key."
  );
  // Damaged key data and a failed save are not the typed key's fault.
  for (const raw of ["CorruptKeyMaterial", "SqliteWriteFailed", "Locked"]) {
    const message = recoveryUnlockMessage(new Error(`handler_failed: ${raw}`));
    assert.notEqual(message, "Wrong recovery key.");
    assert.equal(message, "Could not unlock with the recovery key.");
  }
  assert.equal(
    recoveryUnlockMessage(new Error("handler_failed: RecoveryKeyUnavailable")),
    "This journal has no recovery key."
  );
});
