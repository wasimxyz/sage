/**
 * Small slips that a pattern can catch in a Chat reply. They need no judge.
 *
 * - `shows-internals`: the reply shows a part of how Sage works. That is an id
 *   such as `entry-12` or `chat-3`, a tool name, "the user" for the person,
 *   Sage's own talk of "search results" or "tool calls" ("my search results",
 *   "the tool call"), or JSON. "The user manual" and "your job search results"
 *   are ordinary prose, and do not count.
 * - `many-questions`: more than one question mark outside quotes.
 * - `not-chat-length`: a word count outside the sweep's `replyWords`. A
 *   goodbye is exempt from the lower limit, because a short one is right.
 * - `formatting`: a heading, a bullet list, a table, or code, in any reply
 *   except a `question`, `recap`, or `advice`, where a list can be the answer.
 *
 * The other two slips, `wrong-pronouns` and `assumptions`, need the fact sheet,
 * so the reply judge answers them (see `rubric.ts`).
 *
 * Words inside straight or curly double quotes are the person's own, quoted
 * back. Question marks and "the user" in them do not count.
 */
import type { Expect } from "./schema.ts";

export const PATTERN_SLIP_IDS = [
  "shows-internals",
  "many-questions",
  "not-chat-length",
  "formatting",
] as const;
export type PatternSlipId = (typeof PATTERN_SLIP_IDS)[number];

/** The kinds of message where a list or code can be the answer. */
export const FORMATTING_EXEMPT_EXPECTS = [
  "question",
  "recap",
  "advice",
] as const satisfies readonly Expect[];

export interface SlipFinding {
  /** False when the slip does not apply to this reply. */
  applies: boolean;
  /** The words that show it. */
  evidence?: string;
  flagged: boolean;
  id: PatternSlipId;
  reason: string;
}

export interface SlipInput {
  expect: Expect;
  reply: string;
  /** The sweep's `replyWords`: fewest and most words. */
  replyWords: readonly [number, number];
}

const straightQuotePattern = /"[^"]{0,400}"/gu;
const curlyQuotePattern = /“[^”]{0,400}”/gu;
const questionRunPattern = /\?+/gu;
const questionSentencePattern = /[^.!?\n]*\?+/gu;
const wordPattern = /[\p{L}\p{N}]/u;
const whitespacePattern = /\s+/u;

// Internals, by kind. Each pattern is tested against the reply.
const ID_PATTERN = /\b(?:entry|chat)-\d+\b/iu;
const TOOL_NAME_PATTERN =
  /\b(?:search_journal|get_journal_entry|search_chats|get_chat|facts__search_memories|search_memories)\b/iu;
// "the user" as a word for the person. A noun after it makes it ordinary
// prose: "the user manual", "the user interface", "the user name".
const THE_USER_PATTERN =
  /\bthe user\b(?!\s+(?:manual|guide|handbook|interface|experience|name|base|account|agreement|story|stories|settings|profile|documentation|docs)\b)/iu;
// Sage's own tool talk: "my search results", "the search results show",
// "according to the search results". Ordinary prose about the person's own
// search ("your job search results") has a "your" or another word there.
const MECHANICS_PATTERN =
  /\b(?:my|the) (?:search|tool|query|function|lookup) (?:results?|output|calls?|response)\b/iu;
const JSON_PATTERN = /[{[]\s*"[^"\n]{1,60}"\s*:|```json/iu;

const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+\S/mu;
const LIST_LINE_PATTERN = /^\s*(?:[-*•+]|\d+[.)])\s+\S/gmu;
const TABLE_SEPARATOR_PATTERN =
  /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/mu;
const CODE_PATTERN = /```|`[^`\n]+`/u;

/** The reply with the words inside double quotes taken out. */
export function withoutQuotes(text: string): string {
  return text
    .replace(straightQuotePattern, " ")
    .replace(curlyQuotePattern, " ");
}

/** Words in a reply: pieces split on whitespace that hold a letter or a digit. */
export function countReplyWords(text: string): number {
  return text
    .split(whitespacePattern)
    .filter((piece) => wordPattern.test(piece)).length;
}

function clip(text: string, length = 80): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}

// ---------------------------------------------------------------------------
// The slips
// ---------------------------------------------------------------------------

/** `shows-internals`. */
export function showsInternals(reply: string): SlipFinding {
  const unquoted = withoutQuotes(reply);
  const found: { kind: string; match: string }[] = [];
  const add = (kind: string, text: string, pattern: RegExp): void => {
    const match = pattern.exec(text);
    if (match !== null) {
      found.push({ kind, match: match[0] });
    }
  };
  add("an id", reply, ID_PATTERN);
  add("a tool name", reply, TOOL_NAME_PATTERN);
  add('"the user"', unquoted, THE_USER_PATTERN);
  add("a mention of search results or tool calls", unquoted, MECHANICS_PATTERN);
  add("JSON", reply, JSON_PATTERN);
  const flagged = found.length > 0;
  return {
    applies: true,
    evidence: flagged ? found.map((item) => item.match).join("; ") : undefined,
    flagged,
    id: "shows-internals",
    reason: flagged
      ? `The reply shows ${found.map((item) => `${item.kind} (${clip(item.match, 40)})`).join(", ")}.`
      : "The reply shows none of Sage's internals.",
  };
}

/** `many-questions`. */
export function manyQuestions(reply: string): SlipFinding {
  const unquoted = withoutQuotes(reply);
  const count = unquoted.match(questionRunPattern)?.length ?? 0;
  const flagged = count > 1;
  const sentences = (unquoted.match(questionSentencePattern) ?? [])
    .map((sentence) => clip(sentence, 80))
    .slice(0, 4);
  let reason = "The reply asks no question.";
  if (flagged) {
    reason = `The reply asks ${count} questions. It should ask at most one.`;
  } else if (count === 1) {
    reason = "The reply asks one question.";
  }
  return {
    applies: true,
    evidence: flagged ? sentences.join(" | ") : undefined,
    flagged,
    id: "many-questions",
    reason,
  };
}

/** `not-chat-length`. */
export function notChatLength(
  reply: string,
  replyWords: readonly [number, number],
  expect: Expect
): SlipFinding {
  const [fewest, most] = replyWords;
  const count = countReplyWords(reply);
  // A goodbye is short on purpose.
  const lower = expect === "goodbye" ? 0 : fewest;
  const tooShort = count < lower;
  const tooLong = count > most;
  const flagged = tooShort || tooLong;
  let reason = `${count} words, within ${fewest} to ${most}.`;
  if (tooShort) {
    reason = `${count} words, under the ${fewest} words of a chat reply.`;
  } else if (tooLong) {
    reason = `${count} words, over the ${most} words of a chat reply.`;
  }
  if (!flagged && expect === "goodbye" && count < fewest) {
    reason = `${count} words. A goodbye can be shorter than ${fewest}.`;
  }
  return {
    applies: true,
    evidence: flagged ? `${count} words` : undefined,
    flagged,
    id: "not-chat-length",
    reason,
  };
}

/** `formatting`. */
export function formattingSlip(reply: string, expect: Expect): SlipFinding {
  if ((FORMATTING_EXEMPT_EXPECTS as readonly Expect[]).includes(expect)) {
    return {
      applies: false,
      flagged: false,
      id: "formatting",
      reason: `Not checked for a ${expect} message, where a list or code can be the answer.`,
    };
  }
  const found: string[] = [];
  if (HEADING_PATTERN.test(reply)) {
    found.push("a heading");
  }
  if ((reply.match(LIST_LINE_PATTERN)?.length ?? 0) >= 2) {
    found.push("a bullet or numbered list");
  }
  if (TABLE_SEPARATOR_PATTERN.test(reply)) {
    found.push("a table");
  }
  if (CODE_PATTERN.test(reply)) {
    found.push("code");
  }
  const flagged = found.length > 0;
  return {
    applies: true,
    evidence: flagged ? clip(reply, 120) : undefined,
    flagged,
    id: "formatting",
    reason: flagged
      ? `The reply has ${found.join(", ")}.`
      : "The reply is plain text.",
  };
}

/** Every pattern slip for one reply, in a fixed order. */
export function checkSlips(input: SlipInput): SlipFinding[] {
  return [
    showsInternals(input.reply),
    manyQuestions(input.reply),
    notChatLength(input.reply, input.replyWords, input.expect),
    formattingSlip(input.reply, input.expect),
  ];
}
