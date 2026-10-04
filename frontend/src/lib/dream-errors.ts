import { handlerErrorMessage } from "./handler-errors.ts";

export const ollamaDownDreamMessage =
  "Ollama isn't running. Start it so Sage can Dream.";

export const ollamaDownDreamTooltip = "Start Ollama so Sage can Dream.";

export function formatDreamError(
  error: unknown,
  fallback = "Could not start dreaming."
): string {
  const message = handlerErrorMessage(error);
  if (message.includes("Ollama is not running")) {
    return ollamaDownDreamMessage;
  }
  return message.length > 0 ? message : fallback;
}
