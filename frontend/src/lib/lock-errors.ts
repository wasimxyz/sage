import { isTooManyAttempts, rawHandlerError } from "./handler-errors.ts";

// Mirrors `min_password_len` in `src/vault.zig`. The password wraps the
// journal key, so a four-character PIN leaves a copied `app.db` open to a
// short offline guess.
export const minPasswordLength = 8;
export const removeEncryptionFirst =
  "Remove encryption before turning off the lock.";
export const lastUnlockMethodMessage =
  "Set a password or remove encryption first.";

// The native side answers a failed lock or encryption command with the name of
// the error, so this matches on names and falls back for the rest.
const namedMessages: ReadonlyArray<readonly [string, string]> = [
  ["WrongPassword", "The current password is wrong."],
  ["CurrentPasswordRequired", "Enter your current password."],
  ["TouchIdUnavailable", "Touch ID is not available on this Mac."],
  ["EncryptionEnabled", removeEncryptionFirst],
  ["LastUnlockMethod", lastUnlockMethodMessage],
  ["PasswordRequired", "Turn on Touch ID or set a password first."],
  ["KeyUnwrapFailed", "Could not open the data key."],
  ["KeychainFailed", "Could not store the key for Touch ID."],
  ["WrongRecoveryKey", "That recovery key is wrong."],
  ["InvalidRecoveryKey", "A recovery key has 24 letters and numbers."],
  [
    "RecoveryKeyRequired",
    "Sage did not make that recovery key. Start again to get a new one.",
  ],
  [
    "RecoveryKeyMismatch",
    "That is not the recovery key Sage showed. Start again to get a new one.",
  ],
  ["RecoveryKeyUnavailable", "This journal has no recovery key."],
  ["Securing", "Sage is still securing your journal. Try again in a moment."],
];

/**
 * What the lock screen says when the recovery key did not unlock. A wrong key
 * says so; anything else, like damaged key data or a failed save, does not
 * blame the key the person typed.
 */
export function recoveryUnlockMessage(error: unknown): string {
  if (rawHandlerError(error).includes("WrongRecoveryKey")) {
    return "Wrong recovery key.";
  }
  return lockErrorMessage(error, "Could not unlock with the recovery key.");
}

export function lockErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("PasswordTooShort")) {
    return `Use at least ${minPasswordLength} characters.`;
  }
  if (isTooManyAttempts(error)) {
    return "Too many attempts. Wait a few seconds and try again.";
  }
  for (const [name, text] of namedMessages) {
    if (message.includes(name)) {
      return text;
    }
  }
  return fallback;
}
