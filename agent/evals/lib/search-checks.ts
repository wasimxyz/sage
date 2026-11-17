/**
 * Search checks: did Chat look when it should, find what the answer depends
 * on, and stay out of a search loop? They read one turn's tool calls and need
 * no judge.
 *
 * What counts as a search:
 *
 * - `search_journal` and `search_chats`, always
 * - `facts__search_memories`, only when the setup has memory on. A memory-off
 *   Chat has no such tool, so a call to it is ignored: it is not a search and
 *   not a tool call.
 *
 * `get_journal_entry` and `get_chat` read one entry or chat in full. They are
 * tool calls, and `found-needed` looks at them, but they are not searches.
 *
 * Which checks apply, by the item's `search` label:
 *
 * - `needless-search` applies to `search: none`. It fails when Chat searched.
 * - `missed-search` applies to `search: needed`. It fails when Chat did not
 *   search.
 * - `found-needed` applies to an item with `needs` on a journal that has
 *   entries, unless the item says `search: none`. It fails for the first need
 *   that was not found or not read, as the next section defines.
 * - `no-runaway-search` (counted) applies to every turn.
 *
 * `search: optional` and no label add no search check, apart from `found-needed`
 * and `no-runaway-search`.
 *
 * Found and read, precisely. The turn finds a need when the need's id
 * (`entry-12` or `chat-3`) is in the result of a search call that completed.
 * The search result shows only a snippet: Dream's summary of an entry, or one
 * message of a chat. So a need must also be read in full when no snippet in
 * the turn holds all of the entry's or chat's text. It is read when the turn
 * has a completed `get_journal_entry` (for an entry) or `get_chat` (for a
 * chat) call with that id. A need passes when it is found, and it is either
 * read or its snippet held everything. An entry short enough to fit in its
 * snippet needs no read. A chat is cut into messages, so a search never shows
 * it whole and a read is always needed.
 *
 * On the empty journal there is nothing to find, so `found-needed` does not
 * apply and a need is never expected there.
 */
import {
  chatIdFor,
  journalIdFor,
  type LoadedPerson,
  type Manifest,
  resolveNeed,
} from "./dataset.ts";
import type { SearchExpectation, SearchMetricId, ToolCall } from "./schema.ts";
import {
  CHAT_READ_TOOL,
  countsTowardTurn,
  ENTRY_READ_TOOL,
  searchCallsOf,
} from "./tool-names.ts";

const entryIdPattern = /^entry-[1-9]\d*$/u;
const chatIdPattern = /^chat-[1-9]\d*$/u;
const readIdPattern = /^\s*(?:(entry|chat)-)?([1-9]\d*)\s*$/iu;
const whitespacePattern = /\s+/gu;
const trailingEllipsisPattern = /(?:…|\.{3})\s*$/u;

/** A need the turn has to find: an entry or a past chat, with the id the tools show. */
export interface SearchNeed {
  /** The id the tools use: `entry-12` or `chat-3`. */
  id: string;
  /** What the item's `needs` list calls it: a stem, or `chat:<stem>`. */
  ref: string;
  /** The whole text of the entry or chat, to tell whether a snippet held all of it. */
  text: string;
}

export interface SearchCheckInput {
  /** True on the empty journal. */
  journalEmpty: boolean;
  /** The sweep's `maxToolCallsPerTurn`. */
  maxToolCallsPerTurn: number;
  /** True when the setup has memory on. */
  memory: boolean;
  needs: readonly SearchNeed[];
  /** The item's label. Unset adds no needless or missed check. */
  search: SearchExpectation | undefined;
  toolCalls: readonly ToolCall[];
}

export type SearchCheckId = SearchMetricId | "no-runaway-search";

export interface SearchCheckResult {
  checkId: SearchCheckId;
  /** Words from the turn that show why. */
  evidence?: string;
  /** Extra metadata for the report. */
  extra?: Record<string, unknown>;
  pass: boolean;
  reason: string;
  /** `search` for the soft metrics, `counted` for the runaway check. */
  tier: "counted" | "search";
}

// ---------------------------------------------------------------------------
// Reading tool calls
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWords(text: string): string {
  return text.trim().toLowerCase().replace(whitespacePattern, " ");
}

function quoted(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? ` "${value.trim()}"`
    : "";
}

/** The call as the reader of a report would say it: `search_journal "rent" when "June"`. */
export function describeCall(call: ToolCall): string {
  const { query, when } = call.input;
  const when_ =
    typeof when === "string" && when.trim().length > 0
      ? ` when "${when.trim()}"`
      : "";
  return `${call.name}${quoted(query)}${when_}`;
}

/** Two search calls are the same search when the tool, the query, and `when` match. `limit` is ignored. */
export function searchKey(call: ToolCall): string {
  const field = (name: string) => {
    const value = call.input[name];
    return typeof value === "string" ? normalizeWords(value) : "";
  };
  return `${call.name}\u0000${field("query")}\u0000${field("when")}`;
}

/** Every `entry-N` and `chat-N` id in a tool result. */
export function idsInResult(output: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const id = value.trim().toLowerCase();
      if (entryIdPattern.test(id) || chatIdPattern.test(id)) {
        found.add(id);
      }
    } else if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
    } else if (isRecord(value)) {
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(output);
  return found;
}

/** Every string inside the parts of a result that name `id`, such as its snippet or summary. */
function snippetsFor(output: unknown, id: string): string[] {
  const snippets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      snippets.push(value);
    } else if (Array.isArray(value)) {
      for (const child of value) {
        collect(child);
      }
    } else if (isRecord(value)) {
      for (const child of Object.values(value)) {
        collect(child);
      }
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
    } else if (isRecord(value)) {
      const names = [value.id, value.source].some(
        (field) =>
          typeof field === "string" && field.trim().toLowerCase() === id
      );
      if (names) {
        collect(value);
      } else {
        for (const child of Object.values(value)) {
          visit(child);
        }
      }
    }
  };
  visit(output);
  return snippets;
}

/** True when a snippet holds the whole text, not a cut of it. */
function snippetHolds(snippet: string, text: string): boolean {
  const shown = normalizeWords(snippet.replace(trailingEllipsisPattern, ""));
  const whole = normalizeWords(text);
  return whole.length > 0 && shown.includes(whole);
}

/** The id a `get_journal_entry` or `get_chat` call reads, or null when the call names none. */
export function readTarget(call: ToolCall): string | null {
  let wanted: "chat" | "entry" | null = null;
  if (call.name === ENTRY_READ_TOOL) {
    wanted = "entry";
  } else if (call.name === CHAT_READ_TOOL) {
    wanted = "chat";
  }
  if (wanted === null) {
    return null;
  }
  const raw = call.input.id;
  const match = readIdPattern.exec(
    typeof raw === "number" || typeof raw === "string" ? String(raw) : ""
  );
  if (match === null) {
    return null;
  }
  // A plain number reads as an entry, as `lib/ids.ts` reads it.
  const kind = match[1]?.toLowerCase() ?? "entry";
  return kind === wanted ? `${kind}-${match[2]}` : null;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function pluralCalls(count: number): string {
  return count === 1 ? "1 search" : `${count} searches`;
}

function needless(searches: readonly ToolCall[]): SearchCheckResult {
  const pass = searches.length === 0;
  return {
    checkId: "needless-search",
    evidence: pass ? undefined : searches.map(describeCall).join("; "),
    extra: { searches: searches.length },
    pass,
    reason: pass
      ? "Chat did not search on a turn that needed no search."
      : `Chat made ${pluralCalls(searches.length)} on a turn that needed none.`,
    tier: "search",
  };
}

function missed(searches: readonly ToolCall[]): SearchCheckResult {
  const pass = searches.length > 0;
  return {
    checkId: "missed-search",
    extra: { searches: searches.length },
    pass,
    reason: pass
      ? `Chat searched (${pluralCalls(searches.length)}) on a turn that needed one.`
      : "Chat made no search on a turn that needed one.",
    tier: "search",
  };
}

interface NeedOutcome {
  found: boolean;
  id: string;
  read: boolean;
  readRequired: boolean;
  ref: string;
}

function outcomeOf(
  need: SearchNeed,
  searches: readonly ToolCall[],
  reads: ReadonlySet<string>
): NeedOutcome {
  const hits = searches.filter(
    (call) =>
      call.status === "completed" && idsInResult(call.output).has(need.id)
  );
  const found = hits.length > 0;
  const held = hits.some((call) =>
    snippetsFor(call.output, need.id).some((snippet) =>
      snippetHolds(snippet, need.text)
    )
  );
  return {
    found,
    id: need.id,
    read: reads.has(need.id),
    readRequired: found && !held,
    ref: need.ref,
  };
}

function describeMiss(outcome: NeedOutcome): string | null {
  if (!outcome.found) {
    return `${outcome.ref} (${outcome.id}) is in no search result`;
  }
  if (outcome.readRequired && !outcome.read) {
    return `${outcome.ref} (${outcome.id}) was found but not read in full, and its snippet did not hold it all`;
  }
  return null;
}

function foundNeeded(
  needs: readonly SearchNeed[],
  searches: readonly ToolCall[],
  toolCalls: readonly ToolCall[]
): SearchCheckResult {
  const readIds = new Set<string>();
  for (const call of toolCalls) {
    const target = call.status === "completed" ? readTarget(call) : null;
    if (target !== null) {
      readIds.add(target);
    }
  }
  const outcomes = needs.map((need) => outcomeOf(need, searches, readIds));
  const misses = outcomes.flatMap((outcome) => {
    const miss = describeMiss(outcome);
    return miss === null ? [] : [miss];
  });
  const pass = misses.length === 0;
  return {
    checkId: "found-needed",
    extra: { needs: outcomes },
    pass,
    reason: pass
      ? `Every entry or chat the answer depends on was found (${outcomes.map((o) => o.ref).join(", ")}).`
      : `${misses.join("; ")}.`,
    tier: "search",
  };
}

function runaway(
  calls: readonly ToolCall[],
  searches: readonly ToolCall[],
  max: number
): SearchCheckResult {
  const problems: string[] = [];
  if (calls.length > max) {
    problems.push(
      `${calls.length} tool calls in one turn, over the limit of ${max}`
    );
  }
  const seen = new Map<string, { call: ToolCall; times: number }>();
  for (const call of searches) {
    const key = searchKey(call);
    const earlier = seen.get(key);
    seen.set(key, {
      call: earlier?.call ?? call,
      times: (earlier?.times ?? 0) + 1,
    });
  }
  for (const { call, times } of seen.values()) {
    if (times > 1) {
      problems.push(
        `the same search sent ${times} times: ${describeCall(call)}`
      );
    }
  }
  const pass = problems.length === 0;
  return {
    checkId: "no-runaway-search",
    evidence: pass ? undefined : problems.join("; "),
    extra: { toolCalls: calls.length },
    pass,
    reason: pass
      ? `${calls.length} tool call${calls.length === 1 ? "" : "s"}, no search sent twice.`
      : `${problems.join("; ")}.`,
    tier: "counted",
  };
}

/**
 * The search checks that apply to one turn. See the top of this file for which
 * apply and what each one means.
 */
export function searchChecks(input: SearchCheckInput): SearchCheckResult[] {
  const counted = input.toolCalls.filter((call) =>
    countsTowardTurn(call.name, input.memory)
  );
  const searches = searchCallsOf(counted, input.memory);
  const results: SearchCheckResult[] = [];
  if (input.search === "none") {
    results.push(needless(searches));
  }
  if (input.search === "needed") {
    results.push(missed(searches));
  }
  if (
    input.needs.length > 0 &&
    !input.journalEmpty &&
    input.search !== "none"
  ) {
    results.push(foundNeeded(input.needs, searches, counted));
  }
  results.push(runaway(counted, searches, input.maxToolCallsPerTurn));
  return results;
}

// ---------------------------------------------------------------------------
// Counts for the report
// ---------------------------------------------------------------------------

export interface ToolUse {
  /** Entries and chats read in full. */
  reads: number;
  /** Searches. */
  searches: number;
  /** Every tool call that counts for the setup. */
  toolCalls: number;
}

/** How many searches, reads, and tool calls a turn made, for the setup's memory value. */
export function toolUseOf(
  toolCalls: readonly ToolCall[],
  memory: boolean
): ToolUse {
  const counted = toolCalls.filter((call) =>
    countsTowardTurn(call.name, memory)
  );
  return {
    reads: counted.filter((call) => readTarget(call) !== null).length,
    searches: searchCallsOf(counted, memory).length,
    toolCalls: counted.length,
  };
}

// ---------------------------------------------------------------------------
// From an item's `needs` to ids
// ---------------------------------------------------------------------------

export interface ResolvedNeeds {
  needs: SearchNeed[];
  /** Why a need could not be turned into an id. One line each. */
  problems: string[];
}

function chatTranscript(chat: LoadedPerson["chats"][number]): string {
  return chat.turns.map((turn) => turn.text).join("\n");
}

/**
 * Turns an item's `needs` into the ids the tools show, using the seed step's
 * manifest. A need the manifest has no id for is a problem, not a miss: the
 * seed may have failed, and a model should not pay for it.
 */
export function resolveSearchNeeds(
  owner: LoadedPerson,
  refs: readonly (number | string)[],
  manifest: Manifest | undefined
): ResolvedNeeds {
  const needs: SearchNeed[] = [];
  const problems: string[] = [];
  for (const ref of refs) {
    try {
      const resolved = resolveNeed(owner, ref);
      if (manifest === undefined) {
        throw new Error("There is no manifest of seeded ids.");
      }
      if (resolved.kind === "entry") {
        needs.push({
          id: `entry-${journalIdFor(manifest, owner.id, resolved.entry)}`,
          ref: resolved.entry.stem,
          text: resolved.entry.body,
        });
      } else {
        needs.push({
          id: `chat-${chatIdFor(manifest, owner.id, resolved.chat)}`,
          ref: `chat:${resolved.chat.stem}`,
          text: chatTranscript(resolved.chat),
        });
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { needs, problems };
}
