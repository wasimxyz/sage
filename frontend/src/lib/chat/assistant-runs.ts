import type { EveDynamicToolPart, EveMessagePart } from "eve/client";

import { assistantPartIsVisible } from "./assistant-pending.ts";
import {
  readChatToolName,
  readEntryToolName,
  toolPartName,
} from "./tool-part.ts";

interface ReasoningRun {
  index: number;
  kind: "reasoning";
  streaming: boolean;
  texts: string[];
}

interface ReadsRun {
  kind: "reads";
  parts: EveDynamicToolPart[];
  /** `get_journal_entry` or `get_chat`. A run holds reads of one kind. */
  toolName: string;
}

const readToolNames = new Set([readChatToolName, readEntryToolName]);

interface PartRun {
  index: number;
  kind: "part";
  part: EveMessagePart;
}

export type AssistantRun = PartRun | ReadsRun | ReasoningRun;

/**
 * Groups an assistant message's parts into what Chat draws as one row each.
 * Consecutive reasoning parts become one thinking row, so a streamed trace
 * does not stack several "Thinking..." triggers. Reads of journal entries, or
 * of past chats, with nothing visible between them become one row. Parts that
 * show nothing, such as a step start or an empty text, do not split a group of
 * reads.
 */
export function assistantRuns(
  parts: readonly EveMessagePart[]
): AssistantRun[] {
  const runs: AssistantRun[] = [];
  let reasoning: ReasoningRun | null = null;
  let reads: ReadsRun | null = null;

  for (const [index, part] of parts.entries()) {
    const visible = assistantPartIsVisible(part);
    if (part.type === "reasoning") {
      if (!visible) {
        continue;
      }
      reads = null;
      const streaming = part.state === "streaming";
      if (reasoning) {
        reasoning.texts.push(part.text);
        reasoning.streaming = streaming;
      } else {
        reasoning = { index, kind: "reasoning", streaming, texts: [part.text] };
        runs.push(reasoning);
      }
      continue;
    }
    // Any other part ends a thinking row, even one that shows nothing.
    reasoning = null;
    if (!visible) {
      continue;
    }
    const toolName = part.type === "dynamic-tool" ? toolPartName(part) : "";
    if (part.type === "dynamic-tool" && readToolNames.has(toolName)) {
      if (reads !== null && reads.toolName === toolName) {
        reads.parts.push(part);
      } else {
        reads = { kind: "reads", parts: [part], toolName };
        runs.push(reads);
      }
      continue;
    }
    reads = null;
    runs.push({ index, kind: "part", part });
  }
  return runs;
}
