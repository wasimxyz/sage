import { handlerErrorMessage } from "./handler-errors.ts";

export const ollamaDownTidyMessage =
  "Local AI isn't running, so Sage can't tidy.";

/** The reply came back after the person changed the text it was for. */
export const tidyEditedMessage = "You changed the text, so Tidy did not run.";

const tidyFailedMessage = "Could not tidy the text.";

export interface TidyFailure {
  message: string;
  /** Local AI is down, so the toast can offer to start it. */
  startLocalAi: boolean;
}

/**
 * What to tell the person when `journal.tidy` fails. The core answers with a
 * sentence, and this keeps it, except that it words "Local AI is not running."
 * the way Dream does and says that Start local AI would help.
 */
export function tidyFailure(error: unknown): TidyFailure {
  const message = handlerErrorMessage(error);
  if (message.includes("Local AI is not running")) {
    return { message: ollamaDownTidyMessage, startLocalAi: true };
  }
  return {
    message: message.length > 0 ? message : tidyFailedMessage,
    startLocalAi: false,
  };
}
