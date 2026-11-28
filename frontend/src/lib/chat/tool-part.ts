import type { EveToolPart } from "eve/client";

export const searchJournalToolName = "search_journal";
export const readEntryToolName = "get_journal_entry";
export const searchChatsToolName = "search_chats";
export const readChatToolName = "get_chat";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpErrorOutput(output: unknown): boolean {
  return isRecord(output) && output.isError === true;
}

function nonEmpty(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toolPartName(part: EveToolPart): string {
  return part.name;
}

/**
 * A call whose input is still arriving or whose result has not come back,
 * including one that waits on a person.
 */
export function toolPartRunning(part: EveToolPart): boolean {
  return (
    part.state === "streaming" ||
    part.state === "requested" ||
    part.state === "approval" ||
    part.state === "running" ||
    part.state === "blocked"
  );
}

export function toolPartFailed(part: EveToolPart): boolean {
  if (part.state === "failed") {
    return true;
  }
  return part.state === "completed" && isMcpErrorOutput(part.output);
}

/**
 * The message a failed call came back with, as plain text. A tool error is
 * either eve's error message or an MCP result whose `content` holds the
 * text. Null when there is none to show.
 */
export function toolErrorText(part: EveToolPart): string | null {
  if (part.state === "failed") {
    return nonEmpty(part.error?.message ?? "");
  }
  if (
    part.state !== "completed" ||
    !isRecord(part.output) ||
    !Array.isArray(part.output.content)
  ) {
    return null;
  }
  const lines: string[] = [];
  for (const item of part.output.content) {
    if (isRecord(item) && typeof item.text === "string") {
      lines.push(item.text);
    }
  }
  return nonEmpty(lines.join("\n"));
}
