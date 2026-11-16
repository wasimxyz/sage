/**
 * Review repros for PR 5's data (evals/5-conversations). Each test states what
 * should be true and fails on the current data. Delete after the fixes land.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWhen } from "../../agent/lib/when.ts";
import { checksFor } from "./checks.ts";
import { replyItemForTurn } from "./conversation-checks.ts";
import { replyBaseOf } from "./conversation-grade.ts";
import { loadPeople, loadPerson } from "./dataset.ts";
import { replyItemText } from "./rubric.ts";
import { searchChecks } from "./search-checks.ts";

const TODAY = "2026-11-15";

test("no reply before a scripted crisis is graded as a crisis", async () => {
  const wrong: string[] = [];
  for (const person of await loadPeople()) {
    for (const conversation of person.personCase.conversations) {
      const crisisTurn = conversation.crisis?.turn;
      if (crisisTurn === undefined) {
        continue;
      }
      const base = replyBaseOf(conversation, false);
      for (let turn = 1; turn < crisisTurn; turn += 1) {
        const item = replyItemForTurn(base, turn, crisisTurn);
        const applied = checksFor(item);
        if (applied.hard.includes("crisis-handled")) {
          wrong.push(
            `${person.personCase.id}/${conversation.id} turn ${turn} (crisis at ${crisisTurn}): hard=[${applied.hard}] counted=[${applied.counted}]`
          );
        }
      }
    }
  }
  if (wrong.length > 0) {
    // What the judge reads for the opening of grief/seven-pm-crisis.
    const grief = await loadPerson("grief");
    const seven = grief.personCase.conversations.find(
      (c) => c.id === "seven-pm-crisis"
    );
    if (seven !== undefined) {
      const item = replyItemForTurn(replyBaseOf(seven, false), 1, 4);
      console.log(
        replyItemText({
          item,
          label: "repro",
          message: seven.opening,
          reply: "<a warm reply with no crisis line>",
          toolCalls: [],
        })
      );
    }
  }
  assert.deepEqual(wrong, []);
});

test("long-history turn 15 (the Denver question) can search without a needless-search miss", async () => {
  const person = await loadPerson("long-history");
  const conversation = person.personCase.conversations.find(
    (c) => c.id === "why-i-go-quiet"
  );
  assert.ok(conversation);
  assert.match(conversation.script?.["15"] ?? "", /Denver thing back in January 2025/u);
  const item = replyItemForTurn(replyBaseOf(conversation, false), 15, undefined);
  const results = searchChecks({
    journalEmpty: false,
    maxToolCallsPerTurn: 6,
    memory: false,
    needs: [],
    search: item.search,
    toolCalls: [
      {
        input: { query: "Reese Denver job asked me to come", when: "January 2025" },
        name: "search_journal",
        output: { results: [] },
        status: "completed",
      },
    ],
  });
  const failed = results.filter((r) => !r.pass).map((r) => `${r.checkId}: ${r.reason}`);
  assert.deepEqual(failed, [], `turn 15 is labeled search=${item.search}`);
});

test('long-history did-i-miss-it: "last July" covers the July 2025 entries it needs', async () => {
  const person = await loadPerson("long-history");
  const opener = person.personCase.openers.find((o) => o.id === "did-i-miss-it");
  assert.ok(opener);
  assert.match(opener.message, /last July/u);
  const resolved = resolveWhen("last July", TODAY);
  assert.ok("range" in resolved);
  const outside = opener.needs.filter(
    (need) => need.slice(0, 10) < resolved.range.from || need.slice(0, 10) > resolved.range.to
  );
  assert.deepEqual(
    outside,
    [],
    `"last July" on ${TODAY} is ${resolved.range.from}..${resolved.range.to}`
  );
});

test("conversation replies get a right-help score (fits listed)", async () => {
  const noFits: string[] = [];
  for (const person of await loadPeople()) {
    for (const conversation of person.personCase.conversations) {
      const item = replyItemForTurn(replyBaseOf(conversation, false), 1, conversation.crisis?.turn);
      const rightHelp = checksFor(item).rubric.find((r) => r.id === "right-help");
      if (rightHelp?.notApplicable != null && item.expect !== "crisis") {
        noFits.push(`${person.personCase.id}/${conversation.id}: ${rightHelp.notApplicable}`);
      }
    }
  }
  assert.deepEqual(noFits, []);
});
