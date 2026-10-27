import type { EveDynamicToolPart } from "eve/client";

export const searchJournalToolName = "search_journal";
export const readEntryToolName = "get_journal_entry";

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

export function toolPartName(part: EveDynamicToolPart): string {
  return part.toolMetadata?.eve?.name ?? part.toolName;
}

/** A call whose input is still arriving or whose result has not come back. */
export function toolPartRunning(part: EveDynamicToolPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

export function toolPartFailed(part: EveDynamicToolPart): boolean {
  if (part.state === "output-error") {
    return true;
  }
  return part.state === "output-available" && isMcpErrorOutput(part.output);
}

/**
 * The message a failed call came back with, as plain text. A tool error is
 * either `errorText` or an MCP result whose `content` holds the text. Null
 * when there is none to show.
 */
export function toolErrorText(part: EveDynamicToolPart): string | null {
  if (part.state === "output-error") {
    return nonEmpty(part.errorText);
  }
  if (
    part.state !== "output-available" ||
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
