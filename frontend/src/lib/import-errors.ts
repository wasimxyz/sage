import { handlerErrorMessage } from "./handler-errors.ts";

const partialImportMessage = /^Imported \d+ of \d+ entries?\.$/;

export function formatImportError(error: unknown): string {
  const message = handlerErrorMessage(error);
  if (message.includes("Locked")) {
    return "Unlock the app first.";
  }
  if (message.includes("NotFound")) {
    return "An entry could not be found.";
  }
  if (partialImportMessage.test(message)) {
    return message;
  }
  return "Could not import these entries.";
}
