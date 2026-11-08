import { handlerErrorMessage } from "./handler-errors.ts";

export const ollamaDownDreamMessage =
  "Local AI isn't running, so Sage can't Dream.";

export const ollamaDownDreamPrompt = "Start local AI so Sage can Dream.";

export function formatDreamError(
  error: unknown,
  fallback = "Could not start dreaming."
): string {
  const message = handlerErrorMessage(error);
  if (message.includes("Local AI is not running")) {
    return ollamaDownDreamMessage;
  }
  return message.length > 0 ? message : fallback;
}
