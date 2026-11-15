// Review repros for the PR 4 data. Each test states what the data should do
// and fails on the branch as it is.
import assert from "node:assert/strict";
import test from "node:test";

import { type LoadedPerson, loadPerson, type Manifest } from "./dataset.ts";
import type { ToolCall } from "./schema.ts";
import { resolveSearchNeeds, searchChecks } from "./search-checks.ts";

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
        messages: [
          { chat: chatId(grief, "2026-05-27-two-bowls"), message: 3 },
        ],
      }
    ),
    call("get_chat", { id: chatId(grief, "2026-05-27-two-bowls") }, {}),
  ]);
  assert.equal(result.pass, true, result.reason);
});

test("student last-time-sentence: the sentence is only in the past chat", async () => {
  const student = await loadPerson("student");
  const item = opener(student, "last-time-sentence");
  assert.deepEqual(item.needs, ["chat:2026-10-06-a-small-no"]);
  const leaks = student.entries
    .filter((entry) =>
      entry.body.toLowerCase().includes("let me check my schedule")
    )
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
  const wentInApril = april.body.includes("work, the gym");
  const notSinceMarch = gym.body.includes("I haven't been since March");
  assert.equal(wentInApril && notSinceMarch, false);
});

test("caregiver what-is-sundowning: the journal does not already explain sundowning", async () => {
  const caregiver = await loadPerson("caregiver");
  const item = opener(caregiver, "what-is-sundowning");
  assert.equal(item.search, "none");
  const explains = caregiver.entries
    .filter((entry) => entry.body.toLowerCase().includes("sundowning"))
    .map((entry) => entry.stem);
  assert.deepEqual(explains, [], "the journal holds Pat's sundowning sheet");
});
