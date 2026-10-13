import { rawHandlerError } from "./handler-errors.ts";

/**
 * Why a delete failed. A locked or securing app should try again after it
 * unlocks. A missing row is already gone, which is what the delete wanted.
 */
export type DeleteFailure = "locked" | "missing" | "other";

// The error names the native side reports, and the sentences it sends. The
// names are matched whole and in their own case, so SQLite's "database is
// locked" and the word "unlocked" do not count as the app lock.
const lockedPattern =
  /\b(?:Locked|Securing)\b|Sage is (?:locked|securing)|journal is locked/;
const missingPattern = /\bNotFound\b|(?:Entry|Chat) not found/;

export function deleteFailure(error: unknown): DeleteFailure {
  const message = rawHandlerError(error);
  if (lockedPattern.test(message)) {
    return "locked";
  }
  if (missingPattern.test(message)) {
    return "missing";
  }
  return "other";
}
