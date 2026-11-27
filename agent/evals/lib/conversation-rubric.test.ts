import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  CONVERSATION_RUBRIC,
  CONVERSATION_RUBRIC_TEXTS,
  CONVERSATION_TOOL_RESULT_CHARS,
  type ConversationGradeInput,
  conversationAnswerLines,
  conversationDetailLines,
  conversationGradeCall,
  conversationOutputTokens,
  conversationRubricMaterial,
  conversationTranscript,
  JUDGE_FLAG_IDS,
  PROBE_CONVERSATION_INPUT,
} from "./conversation-rubric.ts";
import {
  conversationCall,
  dreamSourceRubricHash,
  RUBRICS,
  replyCall,
  rubricHash,
  rubricMaterial,
} from "./grader.ts";
import { PROBE_REPLY_INPUT, REPLY_RUBRIC, replyTranscript } from "./rubric.ts";
import {
  conversationGradeSchema,
  JUDGE_CONVERSATION_RUBRIC_IDS,
  SIMULATED_USER_FLAGS,
} from "./schema.ts";

function inputOf(
  labels: Partial<ConversationGradeInput["labels"]> = {},
  exchanges = PROBE_CONVERSATION_INPUT.exchanges
): ConversationGradeInput {
  return {
    ...PROBE_CONVERSATION_INPUT,
    exchanges,
    labels: { ...PROBE_CONVERSATION_INPUT.labels, ...labels },
  };
}

test("the rubric names every conversation item, and the marks the counted checks need", () => {
  for (const id of JUDGE_CONVERSATION_RUBRIC_IDS) {
    assert.ok(CONVERSATION_RUBRIC.includes(`- ${id}. `), id);
    assert.ok(CONVERSATION_RUBRIC_TEXTS[id].length > 40);
  }
  for (const section of [
    "## Conversation rubric",
    "## Loop marks",
    "## Decline marks",
    "## Simulated-user flags",
    "## Your answer",
  ]) {
    assert.ok(CONVERSATION_RUBRIC.includes(section), section);
  }
  // The first time a worry comes up is not a return.
  assert.ok(CONVERSATION_RUBRIC.includes("exchange 1 never is"));
  // The judge never sees the person's own rating, and does not score it.
  assert.ok(!CONVERSATION_RUBRIC.includes("user-rating"));
});

test("the judge may use four flags, and the runner's own is not one of them", () => {
  assert.deepEqual([...JUDGE_FLAG_IDS].sort(), [
    "broke-character",
    "dropped-crisis",
    "refused",
    "soft-after-crisis",
  ]);
  for (const flag of JUDGE_FLAG_IDS) {
    assert.ok(SIMULATED_USER_FLAGS.includes(flag));
    assert.ok(CONVERSATION_RUBRIC.includes(`- ${flag}: `), flag);
  }
  assert.ok(!CONVERSATION_RUBRIC.includes("ended-near-crisis"));
});

test("the answer format follows the schema's field order", () => {
  const answer = CONVERSATION_RUBRIC.slice(
    CONVERSATION_RUBRIC.indexOf("## Your answer")
  );
  const order = [
    "rubric:",
    "loopMarks:",
    "declineMarks:",
    "simulatedUserFlags:",
  ].map((field) => answer.indexOf(`- ${field}`));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  );
  assert.ok(order.every((index) => index >= 0));
  const json: { properties: Record<string, unknown> } = JSON.parse(
    JSON.stringify(z.toJSONSchema(conversationGradeSchema))
  );
  assert.deepEqual(Object.keys(json.properties), [
    "rubric",
    "loopMarks",
    "declineMarks",
    "simulatedUserFlags",
  ]);
});

test("the transcript numbers each exchange, with what Sage did before it replied", () => {
  const text = conversationTranscript(PROBE_CONVERSATION_INPUT.exchanges);
  assert.ok(text.includes("Exchange 1\nPerson: <message>"));
  assert.ok(
    text.includes(
      'search_journal {"query":"<query>"} (completed). Result: {"results":[]}'
    )
  );
  assert.ok(text.includes("Sage: <reply>"));
  assert.ok(text.includes("Exchange 2\nPerson: <next message>"));
  assert.ok(text.includes("Sage made no tool calls."));
  assert.ok(text.includes("Sage: (no reply)"));
});

test("a long tool result is cut to a short piece", () => {
  const long = "x".repeat(CONVERSATION_TOOL_RESULT_CHARS + 300);
  const text = conversationTranscript([
    {
      sage: "ok",
      toolCalls: [
        {
          input: { query: "q" },
          name: "get_chat",
          output: { text: long },
          status: "completed",
        },
      ],
      user: "hi",
    },
  ]);
  assert.ok(text.includes("[cut: "));
  assert.ok(text.length < CONVERSATION_TOOL_RESULT_CHARS + 500);
});

test("the labels say what the person wants, how they talk, and where the crisis was", () => {
  const lines = conversationDetailLines(
    PROBE_CONVERSATION_INPUT.labels,
    2
  ).join("\n");
  for (const part of [
    "What the person wants: vent",
    "Their way of talking: terse",
    "How open they are: guarded",
    "When Sage offers an exercise, they: decline",
    "keep coming back to the same worry: yes",
    "The thought underneath: <thought>",
    "Kinds of help that fit: listen",
    "Kinds of help to avoid: grounding",
    "ended because the person ended it",
    "The person's message at turn 1 was a crisis, sent word for word. After it, the person should: <after the crisis>",
  ]) {
    assert.ok(lines.includes(part), part);
  }
  const plain = conversationDetailLines(
    {
      ...PROBE_CONVERSATION_INPUT.labels,
      avoid: [],
      crisisTurn: undefined,
      ended: "max-turns",
      fits: [],
      journalEmpty: true,
      keyThought: undefined,
      ruminates: false,
    },
    8
  ).join("\n");
  assert.ok(plain.includes("There was no crisis turn."));
  assert.ok(plain.includes("Kinds of help that fit: none listed"));
  assert.ok(plain.includes("The journal is empty."));
  assert.ok(plain.includes("it reached its limit of turns"));
  assert.ok(!plain.includes("The thought underneath"));
});

test("the simulated-user flags are asked only for the messages after the crisis", () => {
  const asked = (crisisTurn: number | undefined, count: number) =>
    conversationAnswerLines({ crisisTurn }, count).join("\n");
  assert.ok(asked(3, 6).includes("the person's messages at turns 4 to 6"));
  assert.ok(asked(6, 6).includes("none to answer"));
  assert.ok(asked(undefined, 6).includes("none to answer"));
  assert.ok(
    asked(2, 4).includes("rubric: follows-lead, collaboration, keeps-track")
  );
});

test("a conversation call is laid out as the rubric, the journal, the conversation, then the labels", () => {
  const call = conversationGradeCall(inputOf());
  assert.equal(call.instructions, CONVERSATION_RUBRIC);
  assert.equal(call.context, "<fact sheet and journal>");
  assert.equal(call.schemaName, "conversation_grade");
  assert.ok(call.transcript?.startsWith("The conversation ("));
  assert.ok(call.item.startsWith("About this conversation:"));
  assert.ok(call.item.includes("What to answer:"));
  assert.equal(conversationCall(inputOf()).schemaName, "conversation_grade");
});

test("a longer conversation expects a longer answer, and the cap is far above it", () => {
  assert.ok(conversationOutputTokens(30) > conversationOutputTokens(8));
  assert.ok(conversationOutputTokens(30) < 8192);
});

test("the rubric hash covers the conversation words, the layout, and the reply's turn lines", () => {
  const before = rubricHash();
  const dreamBefore = dreamSourceRubricHash();
  const original = RUBRICS.conversation;
  (RUBRICS as { conversation: string }).conversation = `${original} Be strict.`;
  try {
    assert.notEqual(rubricHash(), before);
    // A conversation change leaves the cached Dream grades alone.
    assert.equal(dreamSourceRubricHash(), dreamBefore);
  } finally {
    (RUBRICS as { conversation: string }).conversation = original;
  }
  assert.equal(rubricHash(), before);
  const material = rubricMaterial();
  assert.deepEqual(Object.keys(material.conversation), [
    "answerLines",
    "detailLines",
    "endedText",
    "flags",
    "rubricItems",
    "titles",
    "toolResultChars",
  ]);
  assert.deepEqual(material.conversation, conversationRubricMaterial());
  assert.ok(
    Object.keys(material.reply.conversationLines).sort().join() ===
      "atCrisis,before,later,noCrisis"
  );
});

test("a reply in a conversation shows the turns before it, and says where the crisis was", () => {
  const call = replyCall(PROBE_REPLY_INPUT);
  assert.ok(call.transcript?.startsWith("The conversation so far"));
  assert.ok(
    call.transcript?.includes(
      "Person: <earlier message>\nSage: <earlier reply>"
    )
  );
  assert.ok(call.item.includes("This reply is turn 2 of a conversation."));
  assert.ok(
    call.item.includes(
      "crisis of this conversation was the person's message at turn 1"
    )
  );
  // Without earlier turns the transcript is what it was for an opener.
  assert.ok(replyTranscript("m", []).startsWith("The person's message:\nm"));
  assert.ok(
    REPLY_RUBRIC.includes("every reply after the person's crisis message")
  );
});
