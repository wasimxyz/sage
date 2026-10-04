// A failed bridge command rejects with an Error that carries the handler code
// and the message, for example `handler_failed: Ollama did not start in time.`
// The UI shows the message alone.

const handlerFailedPrefix = "handler_failed: ";

/// The text a bridge failure carries, without the handler code.
export function handlerErrorMessage(error: unknown): string {
  const raw = rawHandlerError(error);
  return raw.startsWith(handlerFailedPrefix)
    ? raw.slice(handlerFailedPrefix.length)
    : raw;
}

/// The text a thrown value carries: a string, an Error message, or nothing.
export function rawHandlerError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "";
}

/// True when the native lock refused the guess because the wait is still running.
export function isTooManyAttempts(error: unknown): boolean {
  return rawHandlerError(error).includes("TooManyAttempts");
}
