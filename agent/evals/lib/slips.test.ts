import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSlips,
  countReplyWords,
  formattingSlip,
  manyQuestions,
  notChatLength,
  PATTERN_SLIP_IDS,
  showsInternals,
  withoutQuotes,
} from "./slips.ts";

const pattern13 = /an id/u;
const pattern12 = /a tool name/u;
const pattern11 = /an id.*a tool name.*"the user"/u;
const pattern10 = /entry-12/u;
const pattern9 = /search_journal/u;
const pattern8 = /no question/u;
const pattern7 = /one question/u;
const pattern6 = /2 questions/u;
const pattern5 = /What was that like\?/u;
const pattern4 = /181 words, over the 180/u;
const pattern3 = /1 words, under the 20/u;
const pattern2 = /A goodbye can be shorter/u;
const pattern1 = /Not checked/u;

const WORDS: readonly [number, number] = [20, 180];

/** n plain words. */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

// ---------------------------------------------------------------------------
// shows-internals
// ---------------------------------------------------------------------------

test("shows-internals flags an entry or chat id", () => {
  for (const reply of [
    "In entry-12 you wrote about the rent.",
    "We covered that in chat-3.",
    "As Entry-7 says, you were tired.",
  ]) {
    const finding = showsInternals(reply);
    assert.equal(finding.flagged, true, reply);
    assert.equal(finding.id, "shows-internals");
    assert.match(finding.reason, pattern13);
  }
  const spaced = showsInternals("In entry 12 you wrote about the rent.");
  assert.equal(spaced.flagged, false, "a plain 'entry 12' is not an id");
});

test("shows-internals flags a tool name", () => {
  for (const name of [
    "search_journal",
    "get_journal_entry",
    "search_chats",
    "get_chat",
    "facts__search_memories",
  ]) {
    const finding = showsInternals(`I ran ${name} and found it.`);
    assert.equal(finding.flagged, true, name);
    assert.match(finding.reason, pattern12);
  }
  assert.equal(
    showsInternals("I looked back through what you wrote in March.").flagged,
    false
  );
});

test('shows-internals flags "the user" and talk of search results or tool calls', () => {
  assert.equal(showsInternals("The user seems tired today.").flagged, true);
  assert.equal(
    showsInternals("According to the search results, you wrote about Dad.")
      .flagged,
    true
  );
  assert.equal(
    showsInternals("The tool call returned nothing for March.").flagged,
    true
  );
  assert.equal(
    showsInternals("My query output shows two entries.").flagged,
    true
  );
});

test("shows-internals leaves 'the user' alone inside the person's own quoted words, and ordinary speech alone", () => {
  assert.equal(
    showsInternals('You wrote "the user never reads the manual", and it stung.')
      .flagged,
    false
  );
  assert.equal(
    showsInternals("You wrote “the user never reads the manual”, and it stung.")
      .flagged,
    false
  );
  assert.equal(
    showsInternals("The users group meets on Thursdays, you said.").flagged,
    false
  );
  assert.equal(
    showsInternals("I searched your journal and found two entries about Dad.")
      .flagged,
    false
  );
});

test("shows-internals flags JSON", () => {
  assert.equal(
    showsInternals('Here: {"id": "entry-3", "title": "Rent"}').flagged,
    true
  );
  assert.equal(showsInternals('[{"date":"2026-09-03"}]').flagged, true);
  assert.equal(showsInternals("```json\n{}\n```").flagged, true);
  assert.equal(
    showsInternals("You said {not sure} and then went quiet.").flagged,
    false
  );
});

test("shows-internals lists every kind it found, with the matching words as evidence", () => {
  const finding = showsInternals(
    "The user wrote in entry-12, and search_journal found it."
  );
  assert.equal(finding.flagged, true);
  assert.match(finding.reason, pattern11);
  assert.match(finding.evidence ?? "", pattern10);
  assert.match(finding.evidence ?? "", pattern9);
  assert.equal(showsInternals("All fine.").evidence, undefined);
});

// ---------------------------------------------------------------------------
// many-questions
// ---------------------------------------------------------------------------

test("many-questions flags more than one question mark, and not one or none", () => {
  const none = manyQuestions("That sounds heavy.");
  assert.equal(none.flagged, false);
  assert.match(none.reason, pattern8);
  const one = manyQuestions("What was that like?");
  assert.equal(one.flagged, false);
  assert.match(one.reason, pattern7);
  const two = manyQuestions("What was that like? And what did you do?");
  assert.equal(two.flagged, true);
  assert.match(two.reason, pattern6);
  assert.match(two.evidence ?? "", pattern5);
});

test("many-questions ignores question marks inside quotes, and counts a run of them once", () => {
  assert.equal(
    manyQuestions(
      'You asked "will it ever stop?" and "why me?". Does it feel that way now?'
    ).flagged,
    false
  );
  assert.equal(
    manyQuestions("You asked “will it stop?” twice. What do you make of it?")
      .flagged,
    false
  );
  assert.equal(manyQuestions("Really?? What happened?").flagged, true);
  assert.equal(manyQuestions("What?! That is a lot to carry.").flagged, false);
});

test("many-questions counts a lone quote mark as ordinary text", () => {
  assert.equal(
    manyQuestions('The sign said "closed? What now? And then').flagged,
    true
  );
});

// ---------------------------------------------------------------------------
// not-chat-length
// ---------------------------------------------------------------------------

test("not-chat-length flags a reply under the fewest words and one over the most", () => {
  assert.equal(notChatLength(words(19), WORDS, "venting").flagged, true);
  assert.equal(notChatLength(words(20), WORDS, "venting").flagged, false);
  assert.equal(notChatLength(words(180), WORDS, "venting").flagged, false);
  const long = notChatLength(words(181), WORDS, "venting");
  assert.equal(long.flagged, true);
  assert.match(long.reason, pattern4);
  assert.equal(long.evidence, "181 words");
  const short = notChatLength("Okay.", WORDS, "venting");
  assert.match(short.reason, pattern3);
});

test("not-chat-length reads the sweep's range", () => {
  assert.equal(notChatLength(words(50), [60, 100], "venting").flagged, true);
  assert.equal(notChatLength(words(50), [10, 40], "venting").flagged, true);
  assert.equal(notChatLength(words(50), [10, 60], "venting").flagged, false);
});

test("a goodbye can be short, but it can still be too long", () => {
  const goodbye = notChatLength(
    "Take care, Sam. I'm here when you want to write.",
    WORDS,
    "goodbye"
  );
  assert.equal(goodbye.flagged, false);
  assert.match(goodbye.reason, pattern2);
  assert.equal(notChatLength(words(200), WORDS, "goodbye").flagged, true);
  // Any other kind of message is held to the lower limit.
  assert.equal(
    notChatLength("Take care, Sam.", WORDS, "pushback").flagged,
    true
  );
});

test("countReplyWords counts pieces with a letter or digit, and skips bare marks", () => {
  assert.equal(countReplyWords("It's okay - really. 3 days!"), 5);
  assert.equal(countReplyWords("  \n "), 0);
  assert.equal(countReplyWords("- * ---"), 0);
  assert.equal(countReplyWords("¿Cómo estás? Bien."), 3);
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

test("formatting flags a heading, a bullet list, a numbered list, a table, and code", () => {
  const cases: [string, string][] = [
    ["## What I notice\nYou sound tired.", "a heading"],
    ["Some options:\n- Rest\n- Call Dad", "a bullet or numbered list"],
    ["Some options:\n* Rest\n* Call Dad", "a bullet or numbered list"],
    ["Steps:\n1. Rest\n2) Call Dad", "a bullet or numbered list"],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |", "a table"],
    ["Try this:\n```\nbreathe\n```", "code"],
    ["Say `I need a minute` out loud.", "code"],
  ];
  for (const [reply, kind] of cases) {
    const finding = formattingSlip(reply, "venting");
    assert.equal(finding.flagged, true, reply);
    assert.equal(finding.applies, true);
    assert.ok(finding.reason.includes(kind), `${kind} in ${finding.reason}`);
  }
});

test("formatting leaves plain text, a single dash, one list line, and bold alone", () => {
  for (const reply of [
    "That sounds heavy. What was the worst part of it?",
    "You said - and I think this matters - that you were scared.",
    "One thing stood out:\n- you went quiet after the call",
    "That was **a lot** to carry.",
    "A number: 2026. And 3) is not a list.",
    "Use # signs in a tweet if you like.",
  ]) {
    assert.equal(formattingSlip(reply, "venting").flagged, false, reply);
  }
});

test("formatting is not checked for a question, a recap, or advice", () => {
  const list = "Here you go:\n- one\n- two\n- three";
  for (const expect of ["question", "recap", "advice"] as const) {
    const finding = formattingSlip(list, expect);
    assert.equal(finding.applies, false, expect);
    assert.equal(finding.flagged, false, expect);
    assert.match(finding.reason, pattern1);
  }
  for (const expect of [
    "venting",
    "crisis",
    "good-news",
    "pushback",
    "goodbye",
    "anger",
    "privacy",
    "messy",
    "differs",
    "judge-other",
  ] as const) {
    assert.equal(formattingSlip(list, expect).flagged, true, expect);
  }
});

// ---------------------------------------------------------------------------
// All together
// ---------------------------------------------------------------------------

test("checkSlips gives every pattern slip, in order, and a clean reply is flagged on none", () => {
  const reply =
    "That sounds like a lot to hold on your own. You mentioned the rent twice today, and it seems to sit under everything else. What feels heaviest right now?";
  const findings = checkSlips({ expect: "venting", reply, replyWords: WORDS });
  assert.deepEqual(
    findings.map((finding) => finding.id),
    [...PATTERN_SLIP_IDS]
  );
  assert.deepEqual(
    findings.map((finding) => finding.flagged),
    [false, false, false, false]
  );
});

test("checkSlips flags several slips in one reply", () => {
  const reply = "## Summary\n- The user is sad?\n- What now?";
  const findings = checkSlips({ expect: "venting", reply, replyWords: WORDS });
  const flagged = findings
    .filter((finding) => finding.flagged)
    .map((f) => f.id);
  assert.deepEqual(flagged, [
    "shows-internals",
    "many-questions",
    "not-chat-length",
    "formatting",
  ]);
});

test("withoutQuotes removes quoted words and leaves the rest", () => {
  assert.equal(
    withoutQuotes('He said "go?" and left').replace(/\s+/gu, " "),
    "He said and left"
  );
  assert.equal(withoutQuotes("No quotes here?"), "No quotes here?");
});
