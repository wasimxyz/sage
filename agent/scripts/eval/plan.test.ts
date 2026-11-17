import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  dreamKeyId,
  expandSetups,
  parseSweepFile,
} from "../../evals/lib/schema.ts";
import {
  buildPlan,
  DEFERRED_TESTS,
  describePlan,
  distinct,
  resolveTests,
} from "./plan.ts";
import { conversation, makePerson, opener, tempDir } from "./test-fixtures.ts";

const pattern1 = /memory on, summary qwen3\.5:9b/u;
const pattern2 = /1 person: sam/u;
const pattern3 = /1 Sage start, 1 Chat server start/u;

function setupsFor(input: Record<string, unknown>) {
  const sweep = parseSweepFile(input);
  return { setups: expandSetups(sweep), sweep };
}

test("the plan groups setups by Dream snapshot, in loop order", () => {
  const { setups, sweep } = setupsFor({
    chatModels: ["a", "b"],
    contextLengths: [8192, 32_768],
    memory: ["off", "on"],
    prompts: ["baseline", "companion-v1"],
  });
  const people = [makePerson("sam"), makePerson("jo")];
  const plan = buildPlan(setups, people, sweep);

  assert.deepEqual(plan.memoryValues, ["off", "on"]);
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(
    plan.groups.map((g) => g.memory),
    ["off", "on"]
  );
  const [first] = plan.groups;
  assert.deepEqual(
    first?.prompts.map((p) => p.prompt),
    ["baseline", "companion-v1"]
  );
  assert.equal(first?.prompts[0]?.setups.length, 4);
  // Models change slowest, then context length: the last axis moves fastest.
  const order = first?.prompts[0]?.setups.map(
    (s) => `${s.chatModel}/${s.contextLength}`
  );
  assert.deepEqual(order, ["a/8192", "a/32768", "b/8192", "b/32768"]);
  assert.equal(plan.setups.length, 16);
  assert.deepEqual(
    plan.people.map((p) => p.id),
    ["sam", "jo"]
  );
});

test("every setup of a group shares its Dream key", () => {
  const { setups, sweep } = setupsFor({
    chatModels: ["a", "b"],
    summaryModels: ["s1", "s2"],
  });
  const plan = buildPlan(setups, [makePerson("sam")], sweep);
  assert.equal(plan.groups.length, 2);
  for (const group of plan.groups) {
    for (const prompt of group.prompts) {
      for (const setup of prompt.setups) {
        assert.equal(dreamKeyId(setup), group.dreamKeyId);
        assert.equal(setup.summaryModel, group.summaryModel);
      }
    }
  }
});

test("restart counts follow the loops", () => {
  const { setups, sweep } = setupsFor({
    chatModels: ["a", "b"],
    memory: ["off", "on"],
    prompts: ["baseline", "companion-v1"],
    thinking: ["off", "on"],
  });
  const people = [
    makePerson("sam"),
    makePerson("jo"),
    makePerson("kim", { entries: 0 }),
  ];
  const { stats } = buildPlan(setups, people, sweep);
  // Two memory values, so two groups; three people each.
  assert.equal(stats.sageStarts, 6);
  assert.equal(stats.personPasses, 6);
  // One Chat server per prompt per Sage.
  assert.equal(stats.eveDevStarts, 12);
  assert.equal(stats.chatPasses, 16 * 3);
  assert.equal(stats.gradePasses, 16 * 3);
  // Thinking changes without a reload. Each Sage loads model a, then b, then
  // (for the second prompt) a and b again: 4 loads for each of 6 Sages.
  assert.equal(stats.modelLoads, 4 * 6);
});

test("a context length change reloads the model, a thinking change does not", () => {
  const same = setupsFor({ thinking: ["off", "on"] });
  const planSame = buildPlan(same.setups, [makePerson("sam")], same.sweep);
  assert.equal(planSame.stats.modelLoads, 1);
  const contexts = setupsFor({ contextLengths: [8192, 32_768] });
  const planContexts = buildPlan(
    contexts.setups,
    [makePerson("sam")],
    contexts.sweep
  );
  assert.equal(planContexts.stats.modelLoads, 2);
});

test("openers count only when they match the sweep's tags", () => {
  const sam = makePerson("sam", {
    conversations: [conversation("c1", 8, ["deep"]), conversation("c2", 4)],
    openers: [
      opener("a", ["screen"]),
      opener("b"),
      opener("c", ["screen", "quick"]),
    ],
  });
  const { setups, sweep } = setupsFor({ tags: ["screen"] });
  const plan = buildPlan(setups, [sam], sweep);
  assert.equal(plan.people[0]?.counts.openers, 2);
  assert.equal(plan.people[0]?.counts.conversations, 0);
  const all = buildPlan(setups, [sam], { tags: [] });
  assert.equal(all.people[0]?.counts.openers, 3);
  assert.equal(all.people[0]?.counts.conversationTurns, 12);
});

test("describePlan summarises groups, people, and restarts", () => {
  const { setups, sweep } = setupsFor({ memory: ["on"] });
  const lines = describePlan(buildPlan(setups, [makePerson("sam")], sweep));
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", pattern1);
  assert.match(lines[1] ?? "", pattern2);
  assert.match(lines[2] ?? "", pattern3);
});

test("distinct lists a setup field's values in plan order", () => {
  const { setups } = setupsFor({ chatModels: ["b", "a"], prompts: ["x", "y"] });
  assert.deepEqual(distinct(setups, "chatModel"), ["b", "a"]);
  assert.deepEqual(distinct(setups, "prompt"), ["x", "y"]);
});

test("resolveTests keeps eval ids that have files and reports the rest", (t) => {
  const evals = tempDir(t);
  for (const dir of ["person", "chat", "grade"]) {
    mkdirSync(join(evals, dir), { recursive: true });
  }
  writeFileSync(join(evals, "person", "extraction.eval.ts"), "");
  writeFileSync(join(evals, "person", "retrieval.eval.ts"), "");
  writeFileSync(join(evals, "chat", "facts.eval.ts"), "");
  writeFileSync(join(evals, "grade", "facts.eval.ts"), "");
  const resolved = resolveTests(
    ["person", "facts", "openers", "head-to-head"],
    evals
  );
  assert.deepEqual(resolved.prefixes.person, [
    "person/extraction",
    "person/retrieval",
  ]);
  assert.deepEqual(resolved.prefixes.chat, ["chat/facts"]);
  assert.deepEqual(resolved.prefixes.grade, ["grade/facts"]);
  assert.deepEqual(resolved.missing.sort(), [
    "chat/openers",
    "grade/replies",
    "person/summaries",
  ]);
  assert.deepEqual(resolved.deferred, ["head-to-head"]);
});

test("a folder counts as an eval prefix", (t) => {
  const evals = tempDir(t);
  mkdirSync(join(evals, "chat", "facts"), { recursive: true });
  const resolved = resolveTests(["facts"], evals);
  assert.deepEqual(resolved.prefixes.chat, ["chat/facts"]);
});

test("calibration and head-to-head wait for later passes", () => {
  assert.deepEqual([...DEFERRED_TESTS].sort(), ["calibration", "head-to-head"]);
});
