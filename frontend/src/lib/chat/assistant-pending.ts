import type {
  EveMessage,
  EveMessagePart,
  SessionStoreStatus,
} from "eve/client";

export function assistantPartIsVisible(part: EveMessagePart): boolean {
  if (part.type === "text") {
    return part.text.length > 0;
  }
  if (part.type === "reasoning") {
    return part.text.trim().length > 0;
  }
  return part.type === "tool" && part.hidden !== true;
}

function assistantHasVisibleContent(message: EveMessage): boolean {
  return message.parts.some((part) => assistantPartIsVisible(part));
}

export function shouldShowAssistantPending(
  messages: readonly EveMessage[],
  status: SessionStoreStatus
): boolean {
  if (status !== "busy") {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "user") {
      return true;
    }
    if (assistantHasVisibleContent(message)) {
      return false;
    }
  }
  return false;
}
