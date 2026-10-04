import { handlerErrorMessage } from "../handler-errors.ts";

const unlockMessage = "Unlock the app first.";
const missingChatMessage = "This chat could not be found.";
const lockedPattern = /journal is locked/i;
const agentDownPattern =
  /Server returned 50[234]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|Failed to fetch|fetch failed/i;

export function formatChatSaveError(error: unknown): string {
  return mapChatError(error, "Could not save the chat.");
}

export function formatChatSendError(
  error: unknown,
  downMessage: string
): string {
  if (isAgentDownError(error)) {
    return downMessage;
  }
  return mapChatError(error, "Could not send the message.");
}

function mapChatError(error: unknown, fallback: string): string {
  const message = handlerErrorMessage(error);
  if (message.includes("Locked") || lockedPattern.test(message)) {
    return unlockMessage;
  }
  if (message.includes("NotFound")) {
    return missingChatMessage;
  }
  return fallback;
}

function isAgentDownError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error;
    if (status === 502 || status === 503 || status === 504) {
      return true;
    }
  }
  const message = handlerErrorMessage(error);
  return agentDownPattern.test(message);
}
