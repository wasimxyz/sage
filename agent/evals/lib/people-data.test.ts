// Checks on the shipped people that no schema can make: a `needs` list that
// holds only what the one right answer depends on, an answer that lives in
// one place, and a journal that agrees with itself.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveWhen } from "../../agent/lib/when.ts";
import { checksFor } from "./checks.ts";
import { replyItemForTurn } from "./conversation-checks.ts";
import { replyBaseOf } from "./conversation-grade.ts";
import {
  type LoadedPerson,
  loadPeople,
  loadPerson,
  type Manifest,
  resolveNeed,
} from "./dataset.ts";
import type { ToolCall } from "./schema.ts";
import { resolveSearchNeeds, searchChecks } from "./search-checks.ts";

const TODAY = "2026-11-15";
const lastMonthPattern =
  /\blast (?:january|february|march|april|may|june|july|august|september|october|november|december)\b/giu;
const julyPattern = /\bJuly 2025\b/u;
const januaryPattern = /January 2025/u;

function call(name: string, input: Record<string, unknown>, output: unknown) {
  return {
    input: input as ToolCall["input"],
    name,
    output: output as ToolCall["output"],
    status: "completed",
  } as ToolCall;
}

// Entry n gets id 100 + n, and past chat n gets id 200 + n.
function manifestFor(person: LoadedPerson): Manifest {
  return {
    cases: {
      [person.id]: {
        chatIds: person.chats.map((chat) => 200 + chat.index),
        journalIds: person.entries.map((entry) => 100 + entry.index),
      },
    },
  };
}

function opener(person: LoadedPerson, id: string) {
  const found = person.personCase.openers.find((item) => item.id === id);
  assert.ok(found, `${person.id} has no opener ${id}`);
  return found;
}

function entryId(person: LoadedPerson, stem: string): string {
  const entry = person.entries.find((item) => item.stem === stem);
  assert.ok(entry, `${person.id} has no entry ${stem}`);
  return `entry-${100 + entry.index}`;
}

function chatId(person: LoadedPerson, stem: string): string {
  const chat = person.chats.find((item) => item.stem === stem);
  assert.ok(chat, `${person.id} has no chat ${stem}`);
  return `chat-${200 + chat.index}`;
}

function foundNeeded(
  person: LoadedPerson,
  openerId: string,
  toolCalls: ToolCall[]
) {
  const item = opener(person, openerId);
  const { needs, problems } = resolveSearchNeeds(
    person,
    item.needs,
    manifestFor(person)
  );
  assert.deepEqual(problems, []);
  const result = searchChecks({
    journalEmpty: false,
    maxToolCallsPerTurn: 6,
    memory: false,
    needs,
    search: item.search,
    toolCalls,
  }).find((check) => check.checkId === "found-needed");
  assert.ok(result);
  return result;
}

test("grief nightly-fluids: the answer is only in the 2026-05-27 chat, so needs should point there", async () => {
  const grief = await loadPerson("grief");
  const inJournal = grief.entries.filter((entry) =>
    entry.body.toLowerCase().includes("fluids")
  );
  const chat = grief.chats.find((item) => item.stem === "2026-05-27-two-bowls");
  assert.ok(chat);
  assert.ok(chat.turns.some((turn) => turn.text.includes("two months")));
  assert.deepEqual(inJournal, [], "no journal entry mentions the fluids");
  // A turn that finds and reads the chat with the answer.
  const result = foundNeeded(grief, "nightly-fluids", [
    call(
      "search_chats",
      { query: "Biscuit fluids at home" },
      {
        messages: [{ chat: chatId(grief, "2026-05-27-two-bowls"), message: 3 }],
      }
    ),
    call("get_chat", { id: chatId(grief, "2026-05-27-two-bowls") }, {}),
  ]);
  assert.equal(result.pass, true, result.reason);
});

test("student last-time-sentence: the sentence Sage gave is only in the past chat", async () => {
  const student = await loadPerson("student");
  const item = opener(student, "last-time-sentence");
  assert.deepEqual(item.needs, ["chat:2026-10-06-a-small-no"]);
  const chat = student.chats.find(
    (candidate) => candidate.stem === "2026-10-06-a-small-no"
  );
  assert.ok(chat);
  const sentence = "that doesn't work for me";
  assert.ok(
    chat.turns.some(
      (turn) =>
        turn.role === "assistant" && turn.text.toLowerCase().includes(sentence)
    ),
    "Sage gives the sentence in the chat"
  );
  const leaks = student.entries
    .filter((entry) => entry.body.toLowerCase().includes(sentence))
    .map((entry) => entry.stem);
  assert.deepEqual(leaks, [], "the journal already holds the sentence");
});

test("engaged october-big-thing: a turn that lists October and reads only the big entry finds what it needed", async () => {
  const engaged = await loadPerson("engaged");
  const october = engaged.entries.filter((entry) =>
    entry.date.startsWith("2026-10")
  );
  const result = foundNeeded(engaged, "october-big-thing", [
    call(
      "search_journal",
      { when: "October" },
      {
        entries: october.map((entry) => ({
          date: entry.date,
          id: entryId(engaged, entry.stem),
          snippet: `Summary of ${entry.title}.`,
          title: entry.title,
        })),
      }
    ),
    call(
      "get_journal_entry",
      { id: entryId(engaged, "2026-10-26-lost-mia") },
      {}
    ),
  ]);
  assert.equal(result.pass, true, result.reason);
});

test("family: the gym entry and the April entry agree about the gym", async () => {
  const family = await loadPerson("family");
  const april = family.entries.find(
    (entry) => entry.stem === "2026-04-18-two-weeks-later"
  );
  const gym = family.entries.find(
    (entry) => entry.stem === "2026-08-12-cancelling-the-gym"
  );
  assert.ok(april && gym);
  assert.ok(april.body.includes("work, the gym"));
  assert.ok(gym.body.includes("I haven't been since April"));
  assert.equal(gym.body.includes("since March"), false);
});

test("caregiver what-is-power-of-attorney: neither the journal nor a past chat holds the term", async () => {
  const caregiver = await loadPerson("caregiver");
  const item = opener(caregiver, "what-is-power-of-attorney");
  assert.equal(item.search, "none");
  const texts: [string, string][] = [
    ...caregiver.entries.map((entry): [string, string] => [
      entry.stem,
      entry.body,
    ]),
    ...caregiver.chats.map((chat): [string, string] => [
      chat.stem,
      chat.turns.map((turn) => turn.text).join("\n"),
    ]),
  ];
  const holds = texts
    .filter(([, text]) => text.toLowerCase().includes("power of attorney"))
    .map(([stem]) => stem);
  assert.deepEqual(holds, [], "the journal already holds the term");
});

test("engaged cabin-cost: the price is only in the past chat, so needs holds only the chat", async () => {
  const engaged = await loadPerson("engaged");
  const item = opener(engaged, "cabin-cost");
  assert.deepEqual(item.needs, ["chat:2026-09-22-the-cabin-weekend"]);
  const inJournal = engaged.entries
    .filter((entry) => entry.body.includes("$380"))
    .map((entry) => entry.stem);
  assert.deepEqual(inJournal, [], "the journal holds the price");
});

test("a reply before a scripted crisis is not graded as a crisis", async () => {
  const wrong: string[] = [];
  for (const person of await loadPeople()) {
    for (const conversation of person.personCase.conversations) {
      const crisisTurn = conversation.crisis?.turn;
      if (crisisTurn === undefined) {
        continue;
      }
      const base = replyBaseOf(conversation, false);
      for (let turn = 1; turn < crisisTurn; turn += 1) {
        const applied = checksFor(replyItemForTurn(base, turn, crisisTurn));
        if (applied.hard.includes("crisis-handled")) {
          wrong.push(
            `${person.id}/${conversation.id} turn ${turn} (crisis at ${crisisTurn})`
          );
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test("a conversation with a scripted crisis is not labeled crisis as a whole", async () => {
  const labeled: string[] = [];
  for (const person of await loadPeople()) {
    for (const conversation of person.personCase.conversations) {
      if (
        conversation.crisis !== undefined &&
        conversation.expect === "crisis"
      ) {
        labeled.push(`${person.id}/${conversation.id}`);
      }
    }
  }
  assert.deepEqual(labeled, []);
});

test("an opener that says last and a month means a month that holds the entries it needs", async () => {
  const outside: string[] = [];
  for (const person of await loadPeople()) {
    for (const item of person.personCase.openers) {
      for (const match of item.message.matchAll(lastMonthPattern)) {
        const resolved = resolveWhen(match[0], TODAY);
        assert.ok("range" in resolved, `${person.id}/${item.id}: ${match[0]}`);
        for (const ref of item.needs) {
          const need = resolveNeed(person, ref);
          if (
            need.kind === "entry" &&
            (need.entry.date < resolved.range.from ||
              need.entry.date > resolved.range.to)
          ) {
            outside.push(
              `${person.id}/${item.id}: "${match[0]}" is ${resolved.range.from}..${resolved.range.to}, but ${need.entry.stem} is outside it`
            );
          }
        }
      }
    }
  }
  assert.deepEqual(outside, []);
});

test("long-history did-i-miss-it: the July it names is July 2025, where its entries are", async () => {
  const person = await loadPerson("long-history");
  const item = opener(person, "did-i-miss-it");
  assert.match(item.message, julyPattern);
  const resolved = resolveWhen("July 2025", TODAY);
  assert.ok("range" in resolved);
  for (const ref of item.needs) {
    const need = resolveNeed(person, ref);
    assert.equal(need.kind, "entry");
    if (need.kind === "entry") {
      assert.ok(
        need.entry.date >= resolved.range.from &&
          need.entry.date <= resolved.range.to,
        `${need.entry.stem} is not in July 2025`
      );
    }
  }
});

test("every conversation lists the kinds of help that fit, so its replies get a right-help score", async () => {
  const noFits: string[] = [];
  for (const person of await loadPeople()) {
    for (const conversation of person.personCase.conversations) {
      const item = replyItemForTurn(
        replyBaseOf(conversation, false),
        1,
        conversation.crisis?.turn
      );
      const rightHelp = checksFor(item).rubric.find(
        (rubric) => rubric.id === "right-help"
      );
      if (
        rightHelp !== undefined &&
        rightHelp.notApplicable !== null &&
        item.expect !== "crisis"
      ) {
        noFits.push(
          `${person.id}/${conversation.id}: ${rightHelp.notApplicable}`
        );
      }
    }
  }
  assert.deepEqual(noFits, []);
});

async function conversationOf(personId: string, conversationId: string) {
  const person = await loadPerson(personId);
  const conversation = person.personCase.conversations.find(
    (candidate) => candidate.id === conversationId
  );
  assert.ok(conversation, `${personId}/${conversationId} exists`);
  return { conversation, person };
}

test("a reply before the crisis of driveway-rage-crisis is graded as the venting it is", async () => {
  const { conversation } = await conversationOf(
    "family",
    "driveway-rage-crisis"
  );
  const base = replyBaseOf(conversation, false);
  const crisisTurn = conversation.crisis?.turn;
  assert.notEqual(crisisTurn, undefined);
  const kinds = Array.from(
    { length: (crisisTurn ?? 1) + 1 },
    (_, index) => replyItemForTurn(base, index + 1, crisisTurn).expect
  );
  assert.deepEqual(kinds, [
    ...Array.from({ length: (crisisTurn ?? 1) - 1 }, () => "venting"),
    "crisis",
    "crisis",
  ]);
});

test("anger and pushback are graded on the scripted turn that carries them, and the rest of the conversation is venting", async () => {
  // Each opens with a message that is not the anger or the pushback.
  for (const [personId, conversationId, kind] of [
    ["new-user", "not-helping", "anger"],
    ["grief", "waves-pushback", "pushback"],
    ["recovery", "not-thanksgiving", "pushback"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: three small files, read one at a time
    const { conversation } = await conversationOf(personId, conversationId);
    const base = replyBaseOf(conversation, personId === "new-user");
    const scripted = Object.keys(conversation.script ?? {}).map(Number);
    assert.ok(scripted.length > 0, `${conversationId} has a scripted turn`);
    for (let turn = 1; turn <= conversation.maxTurns; turn += 1) {
      const item = replyItemForTurn(base, turn, conversation.crisis?.turn);
      assert.equal(
        item.expect,
        scripted.includes(turn) ? kind : "venting",
        `${personId}/${conversationId} turn ${turn}`
      );
    }
    // The opening keeps the checks of a plain message.
    assert.ok(
      checksFor(replyItemForTurn(base, 1, undefined)).counted.includes(
        "no-brushing-off"
      ),
      `${conversationId}: the opening is not the ${kind}`
    );
  }
});

test("long-history why-i-go-quiet: turn 15 asks what the journal says, so it needs a search that finds the Denver entry", async () => {
  const { conversation, person } = await conversationOf(
    "long-history",
    "why-i-go-quiet"
  );
  const turn = conversation.script?.["15"];
  assert.match(turn?.message ?? "", januaryPattern);
  assert.equal(turn?.search, "needed");
  const base = replyBaseOf(conversation, false);
  const item = replyItemForTurn(base, 15, undefined);
  assert.equal(item.search, "needed");
  // The ordinary turns around it still react to what was said.
  assert.equal(replyItemForTurn(base, 14, undefined).search, "none");
  assert.equal(replyItemForTurn(base, 16, undefined).search, "none");
  const { needs, problems } = resolveSearchNeeds(
    person,
    turn?.needs ?? [],
    manifestFor(person)
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    needs.map((need) => need.id),
    [entryId(person, "2025-01-12-denver")]
  );
  const search = call(
    "search_journal",
    { query: "Denver job January 2025" },
    { results: [{ id: entryId(person, "2025-01-12-denver") }] }
  );
  const checks = (toolCalls: ToolCall[]) =>
    searchChecks({
      journalEmpty: false,
      maxToolCallsPerTurn: 6,
      memory: false,
      needs,
      search: item.search,
      toolCalls,
    });
  // A search is not needless, and no search is a miss.
  assert.notEqual(
    checks([search]).find((result) => result.checkId === "needless-search")
      ?.pass,
    false
  );
  assert.equal(
    checks([]).find((result) => result.checkId === "missed-search")?.pass,
    false
  );
});
