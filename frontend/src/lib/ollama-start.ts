import { handlerErrorMessage } from "./handler-errors.ts";

const ollamaStartFailedMessage = "Could not start Ollama.";

/// A Start Ollama button: `starting` holds until a status read reports the
/// server, and `failed` carries the reason it did not.
export type OllamaStartLoad =
  | { kind: "failed"; message: string }
  | { kind: "idle" }
  | { kind: "starting" };

/// The failed state for an `ollama.start` that threw.
export function ollamaStartFailed(caught: unknown): OllamaStartLoad {
  return {
    kind: "failed",
    message: handlerErrorMessage(caught) || ollamaStartFailedMessage,
  };
}
