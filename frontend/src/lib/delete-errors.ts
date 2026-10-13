import { rawHandlerError } from "./handler-errors.ts";

/**
 * Why a delete failed. A locked or securing app should try again after it
 * unlocks. A missing row is already gone, which is what the delete wanted.
 */
export type DeleteFailure = "locked" | "missing" | "other";

const lockedPattern = /Locked|Securing|is locked|is securing/i;
const missingPattern = /NotFound|not found/i;

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
