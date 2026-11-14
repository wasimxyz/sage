/**
 * The names of Chat's tools, and which of them are searches. The search checks
 * and the judge's N/A rule for search quality both read them.
 *
 * - `search_journal` and `search_chats` are always searches.
 * - The memory tool is a search only in a setup with memory on. A memory-off
 *   Chat has no such tool, so a call to it is ignored: it is not a search and
 *   not a tool call.
 * - `get_journal_entry` and `get_chat` read one entry or chat in full. They
 *   are tool calls, not searches.
 */
import type { ToolCall } from "./schema.ts";

export const JOURNAL_SEARCH_TOOL = "search_journal";
export const CHAT_SEARCH_TOOL = "search_chats";
export const ENTRY_READ_TOOL = "get_journal_entry";
export const CHAT_READ_TOOL = "get_chat";

/** The memory tool's name ends with this. eve puts the memory slot's name in front. */
const MEMORY_SEARCH_SUFFIX = /(?:^|__)search_memories$/u;

/** True for the memory search tool. */
export function isMemoryTool(name: string): boolean {
  return MEMORY_SEARCH_SUFFIX.test(name);
}

/** True when the call counts for this setup. A memory-off setup ignores the memory tool. */
export function countsTowardTurn(name: string, memory: boolean): boolean {
  return memory || !isMemoryTool(name);
}

/** True for a search call that counts for this setup. */
export function isSearchCall(name: string, memory: boolean): boolean {
  if (name === JOURNAL_SEARCH_TOOL || name === CHAT_SEARCH_TOOL) {
    return true;
  }
  return memory && isMemoryTool(name);
}

/** The search calls of a turn that count, in order. */
export function searchCallsOf(
  toolCalls: readonly ToolCall[],
  memory: boolean
): ToolCall[] {
  return toolCalls.filter((call) => isSearchCall(call.name, memory));
}

/**
 * How many search calls a turn made. The judge sees the whole turn, so a
 * memory search counts here whenever it was made.
 */
export function countSearchCalls(toolCalls: readonly ToolCall[]): number {
  return searchCallsOf(toolCalls, true).length;
}
