import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dreamKeyId,
  expandSetups,
  parseSweepFile,
} from "../../evals/lib/schema.ts";
import { loadAllPeople, selectPeople } from "./people.ts";
import {
  buildPlan,
  CONVERSATIONS_EVAL,
  DEFERRED_TESTS,
  describePlan,
  distinct,
  needsChat,
  resolveTests,
  runsConversations,
} from "./plan.ts";
import { defaultSweepsDir, loadSweep } from "./sweep.ts";
import { conversation, makePerson, opener, tempDir } from "./test-fixtures.ts";

const evalsDir = fileURLToPath(new URL("../../evals", import.meta.url));
const noChatPattern = /^4 Sage starts, no Chat/u;
const memoryOffPattern = /^memory off, summary .*: 1 setup$/u;

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
  writeFileSync(join(evals, "grade", "replies.eval.ts"), "");
  const resolved = resolveTests(
    ["person", "facts", "openers", "head-to-head"],
    evals
  );
  assert.deepEqual(resolved.prefixes.person, [
    "person/extraction",
    "person/retrieval",
  ]);
  assert.deepEqual(resolved.prefixes.chat, ["chat/facts"]);
  assert.deepEqual(resolved.prefixes.grade, ["grade/replies"]);
  assert.deepEqual(resolved.missing.sort(), [
    "chat/openers",
    "person/summaries",
  ]);
  assert.deepEqual(resolved.deferred, ["head-to-head"]);
});

test("facts and openers share one grade eval, so each reply is graded once", (t) => {
  const evals = tempDir(t);
  for (const dir of ["chat", "grade"]) {
    mkdirSync(join(evals, dir), { recursive: true });
  }
  for (const file of [
    join("chat", "facts.eval.ts"),
    join("chat", "openers.eval.ts"),
    join("grade", "replies.eval.ts"),
  ]) {
    writeFileSync(join(evals, file), "");
  }
  const both = resolveTests(["facts", "openers"], evals);
  assert.deepEqual(both.prefixes.chat, ["chat/facts", "chat/openers"]);
  assert.deepEqual(both.prefixes.grade, ["grade/replies"]);
  assert.deepEqual(resolveTests(["openers", "facts"], evals).prefixes.grade, [
    "grade/replies",
  ]);
  assert.deepEqual(resolveTests(["facts"], evals).prefixes.grade, [
    "grade/replies",
  ]);
  assert.deepEqual(resolveTests(["openers"], evals).prefixes.grade, [
    "grade/replies",
  ]);
  assert.deepEqual(both.missing, []);
});

test("the shipped eval files cover openers and facts", () => {
  const resolved = resolveTests(["facts", "openers"], evalsDir);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.prefixes.chat, ["chat/facts", "chat/openers"]);
  assert.deepEqual(resolved.prefixes.grade, ["grade/replies"]);
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

test("a plan with no Chat has Sage starts and person passes, and nothing else", () => {
  const { setups, sweep } = setupsFor({
    chatModels: ["a", "b"],
    memory: ["off", "on"],
    prompts: ["baseline", "companion-v1"],
  });
  const people = [makePerson("sam"), makePerson("jo")];
  const plan = buildPlan(setups, people, sweep, { chat: false });
  assert.equal(plan.chat, false);
  assert.deepEqual(plan.stats, {
    chatPasses: 0,
    eveDevStarts: 0,
    gradePasses: 0,
    modelLoads: 0,
    personPasses: 4,
    sageStarts: 4,
  });
  // The default is a plan with Chat.
  assert.equal(buildPlan(setups, people, sweep).chat, true);
  assert.ok(buildPlan(setups, people, sweep).stats.eveDevStarts > 0);
});

test("a sweep needs Chat only when one of its tests sends a message", () => {
  const prefixes = { chat: [], grade: [], person: ["person/dream-accuracy"] };
  assert.equal(needsChat(prefixes), false);
  assert.equal(needsChat({ ...prefixes, chat: ["chat/facts"] }), true);
});

test("a sweep needs the simulated user only when it plays conversations", () => {
  const prefixes = { chat: ["chat/openers"], grade: [], person: [] };
  assert.equal(runsConversations(prefixes), false);
  assert.equal(
    runsConversations({
      ...prefixes,
      chat: ["chat/openers", CONVERSATIONS_EVAL],
    }),
    true
  );
  // The resolved tests of the shipped sweeps say the same.
  for (const [tests, expected] of [
    [["openers", "facts"], false],
    [["person", "conversations"], true],
    [["person", "dream-accuracy"], false],
  ] as const) {
    assert.equal(
      runsConversations(resolveTests(tests, evalsDir).prefixes),
      expected,
      tests.join(", ")
    );
  }
});

test("the dream sweep runs the person pass and Dream accuracy for each memory value, with no Chat", async () => {
  const loaded = await loadSweep("dream", {}, defaultSweepsDir());
  assert.deepEqual(loaded.sweep.tests, ["person", "dream-accuracy"]);
  const resolved = resolveTests(loaded.sweep.tests, evalsDir);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.deferred, []);
  assert.deepEqual(resolved.prefixes, {
    chat: [],
    grade: [],
    person: [
      "person/extraction",
      "person/summaries",
      "person/retrieval",
      "person/dream-accuracy",
    ],
  });
  assert.equal(needsChat(resolved.prefixes), false);

  const plan = buildPlan(
    loaded.setups,
    [makePerson("sam"), makePerson("jo")],
    loaded.sweep,
    { chat: needsChat(resolved.prefixes) }
  );
  assert.deepEqual(plan.memoryValues, ["off", "on"]);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.stats.sageStarts, 4);
  assert.equal(plan.stats.eveDevStarts, 0);
  assert.equal(plan.stats.modelLoads, 0);
  const lines = describePlan(plan);
  assert.match(lines[0] ?? "", memoryOffPattern);
  assert.match(lines.at(-1) ?? "", noChatPattern);
});

test("the default sweep adds Dream accuracy to the person pass and sends Chat's fact questions and the openers", async () => {
  const loaded = await loadSweep("default", {}, defaultSweepsDir());
  const resolved = resolveTests(loaded.sweep.tests, evalsDir);
  assert.deepEqual(resolved.missing, []);
  assert.ok(resolved.prefixes.person.includes("person/dream-accuracy"));
  assert.deepEqual(resolved.prefixes.chat, ["chat/facts", "chat/openers"]);
  assert.deepEqual(resolved.prefixes.grade, ["grade/replies"]);
  assert.equal(needsChat(resolved.prefixes), true);
});

test("the screen sweep sends only the screen openers on nine models and two prompts, with memory off", async () => {
  const loaded = await loadSweep("screen", {}, defaultSweepsDir());
  const { sweep } = loaded;
  assert.deepEqual(sweep.tags, ["screen"]);
  // The fact questions run in `default`, and later in `deep`. Leaving them out
  // keeps the night near eight hours.
  assert.deepEqual(sweep.tests, ["person", "openers"]);
  assert.deepEqual(sweep.memory, ["off"]);
  assert.deepEqual(sweep.prompts, ["baseline", "companion-v1"]);
  assert.deepEqual(sweep.thinking, ["off"]);
  assert.deepEqual(sweep.chatModels, [
    "qwen3.5:9b",
    "qwen3.5:9b-mlx",
    "qwen3:8b",
    "qwen3:14b",
    "gemma3:12b",
    "mistral-nemo:12b",
    "phi4:14b",
    "lfm2.5:8b",
    "gpt-oss:20b",
  ]);
  assert.equal(sweep.repeats, 1);
  assert.equal(sweep.judge.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(sweep.simulatedUser.model, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(sweep.simulatedUser.providers, [
    "morph",
    "deepinfra",
    "runinfra",
    "relace",
  ]);
  assert.equal(sweep.spendingCapUsd, 50);
  assert.equal(loaded.setups.length, 18);
  const resolved = resolveTests(sweep.tests, evalsDir);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.prefixes.chat, ["chat/openers"]);
});

test("the quick sweep sends only the quick openers, on the default model with the shipped prompt and memory off", async () => {
  const loaded = await loadSweep("quick", {}, defaultSweepsDir());
  const { sweep } = loaded;
  assert.deepEqual(sweep.tags, ["quick"]);
  assert.deepEqual(sweep.tests, ["openers"]);
  assert.deepEqual(sweep.memory, ["off"]);
  assert.deepEqual(sweep.prompts, ["baseline"]);
  assert.deepEqual(sweep.dreamPrompts, ["baseline"]);
  assert.deepEqual(sweep.chatModels, ["qwen3.5:9b"]);
  assert.deepEqual(sweep.thinking, ["off"]);
  assert.equal(sweep.repeats, 1);
  assert.equal(loaded.setups.length, 1);
  assert.equal(sweep.maxToolCallsPerTurn, 6);
  assert.deepEqual(sweep.replyWords, [20, 180]);
  const resolved = resolveTests(sweep.tests, evalsDir);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.prefixes.chat, ["chat/openers"]);
  assert.deepEqual(resolved.prefixes.person, []);
});

test("the quick sweep covers each person with a quick opener, and every item it sends is tagged quick", async () => {
  const { sweep, setups } = await loadSweep("quick", {}, defaultSweepsDir());
  const everyone = await loadAllPeople();
  const selected = selectPeople(everyone, sweep.tags, { openers: true });
  const plan = buildPlan(setups, selected, sweep, { chat: true });
  const quickOpeners = everyone.flatMap((person) =>
    person.personCase.openers.filter((item) => item.tags.includes("quick"))
  );
  assert.ok(quickOpeners.length >= 10, `${quickOpeners.length} quick openers`);
  const sent = plan.people.reduce(
    (sum, person) => sum + person.counts.openers,
    0
  );
  const onEmpty = quickOpeners.filter((item) => item.alsoEmpty).length;
  assert.equal(sent, quickOpeners.length + onEmpty);
  // No fact questions, conversations, or person checks are sent.
  const resolved = resolveTests(sweep.tests, evalsDir);
  assert.deepEqual(resolved.prefixes.chat, ["chat/openers"]);
  // The quick openers that also run on the empty journal never expect a hit there.
  for (const item of quickOpeners.filter((candidate) => candidate.alsoEmpty)) {
    assert.notEqual(item.search, "needed", item.id);
  }
  // Each check kind the plan names is in the quick set at least once.
  const has = (matches: (item: (typeof quickOpeners)[number]) => boolean) =>
    quickOpeners.some(matches);
  assert.ok(
    has((item) => item.expect === "crisis"),
    "a crisis"
  );
  assert.ok(
    has((item) => item.tags.includes("tricky")),
    "not a crisis"
  );
  assert.ok(
    has((item) => item.tags.includes("injection")),
    "an injection"
  );
  assert.ok(
    has((item) => item.search === "needed"),
    "a needed search"
  );
  assert.ok(
    has((item) => item.search === "none"),
    "no search"
  );
  assert.ok(
    has((item) =>
      item.needs.some(
        (ref) => typeof ref === "string" && ref.startsWith("chat:")
      )
    ),
    "a past chat"
  );
});

test("the empty-journal person's opener count includes the other people's alsoEmpty openers", () => {
  const grief = makePerson("grief", {
    openers: [
      opener("a", ["screen"]),
      { ...opener("b", ["screen"]), alsoEmpty: true },
      { ...opener("c"), alsoEmpty: true },
    ],
  });
  const newUser = makePerson("new-user", {
    entries: 0,
    openers: [opener("d", ["screen"])],
  });
  const { setups, sweep } = setupsFor({ tags: ["screen"] });
  const plan = buildPlan(setups, [grief, newUser], sweep);
  const counts = new Map(plan.people.map((p) => [p.id, p.counts.openers]));
  // grief sends a and b on its own journal. new-user sends d, and grief's b on the empty one.
  assert.equal(counts.get("grief"), 2);
  assert.equal(counts.get("new-user"), 2);
  const all = buildPlan(setups, [grief, newUser], { tags: [] });
  assert.equal(all.people.find((p) => p.id === "new-user")?.counts.openers, 3);
});
