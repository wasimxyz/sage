import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { formatFactSheet, formatSourceForJudge } from "./dream-judge-input.ts";
import {
  createGrader,
  DEFAULT_MAX_OUTPUT_TOKENS,
  dreamSourceCall,
  type FactualityGrade,
  factualityGradeSchema,
  type Grader,
  type GraderOptions,
  graderFromEnv,
  ITEM_TITLES,
  JUDGE_TEMPERATURE,
  NOT_GRADED_SPENDING_CAP,
  RUBRICS,
  type RubricKind,
  rubricHash,
  rubricMaterial,
} from "./grader.ts";
import { journalContextLayout } from "./judge-context.ts";
import { LEDGER_FILE, reserve, totals } from "./ledger.ts";
import type { ModelPrice } from "./prices.ts";
import { ENV_RUN_DIR, ENV_SWEEP_FILE, parseSweepFile } from "./schema.ts";

const referenceTheAnswerKeyPattern =
  /Reference \(the answer key\):\nThe author is engaged/u;
const currentFactFromThePattern =
  /Current fact \(from the reference\):\nBiscuit has died\./u;
const staleFactNoLongerPattern =
  /Stale fact \(no longer true\):\nBiscuit is a dog\./u;
const acmeJudge1Pattern = /acme\/judge-1/u;

const whoAmIEngagedPattern = /Who am I engaged to\?/u;
const outputToGradeJordanPattern = /Output to grade:\nJordan is your fiancé\./u;
const notGradedJudgeErrorPattern = /^not graded: judge error: .*boom/u;
const notGradedJudgeError2Pattern = /^not graded: judge error:/u;
const notGradedNoPricePattern = /not graded: no price for nobody\/unlisted/u;
const setupIdPattern = /^[0-9a-f]{10}$/u;
const notGradedNoRunPattern = /not graded: no run directory/u;

const couldNotReadTheSweepPattern = /could not read the sweep/u;
const MODEL_ID = "moonshotai/kimi-k3.1-pro";
const PRICE: ModelPrice = {
  cachedInputPerM: 0.2,
  inputPerM: 2,
  outputPerM: 10,
};
const EPSILON = 1e-9;

interface Usage {
  cached?: number;
  input: number;
  output: number;
}

function generateResult(
  text: string,
  usage: Usage = { input: 1000, output: 200 },
  providerMetadata?: Record<string, Record<string, string>>
) {
  return {
    content: [{ text, type: "text" as const }],
    finishReason: { raw: undefined, unified: "stop" as const },
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    usage: {
      inputTokens: {
        cacheRead: usage.cached,
        cacheWrite: undefined,
        noCache: usage.input - (usage.cached ?? 0),
        total: usage.input,
      },
      outputTokens: {
        reasoning: undefined,
        text: usage.output,
        total: usage.output,
      },
    },
    warnings: [],
  };
}

function verdict(overrides: Partial<FactualityGrade> = {}): string {
  return JSON.stringify({
    evidence: "You are engaged to Jordan.",
    pass: true,
    reason: "The output matches the reference.",
    ...overrides,
  });
}

function tempRunDir(): string {
  return join(mkdtempSync(join(tmpdir(), "sage-grader-")), "run");
}

function graderWith(
  model: MockLanguageModelV4,
  overrides: Partial<GraderOptions> = {}
): { grader: Grader; runDir: string } {
  const runDir = overrides.runDir ?? tempRunDir();
  const grader = createGrader({
    capUsd: 50,
    model,
    modelId: MODEL_ID,
    price: PRICE,
    runDir,
    sweepId: "sweep-1",
    ...overrides,
  });
  return { grader, runDir };
}

function mockReplying(text: string, usage?: Usage): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.resolve(generateResult(text, usage)),
  });
}

function mockThrowing(error: Error): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(error),
  });
}

const factInput = {
  label: "fact-factuality sam/fact/1",
  output: "Jordan is your fiancé.",
  reference: "The author is engaged to Jordan.",
};

function close(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${actual} is not ${expected}`
  );
}

test.afterEach(() => {
  mock.restoreAll();
});

test("factuality returns the verdict, the reason, and the quote", async () => {
  const { grader } = graderWith(mockReplying(verdict()));
  const graded = await grader.factuality(factInput);
  assert.equal(graded.pass, true);
  assert.equal(graded.notGraded, false);
  assert.equal(graded.reason, "The output matches the reference.");
  assert.equal(graded.evidence, "You are engaged to Jordan.");
  assert.equal(graded.model, MODEL_ID);
  assert.equal(graded.rubric, rubricHash());
  assert.ok(graded.callId !== undefined);
});

test("a failing verdict is a plain fail, not an error", async () => {
  const { grader } = graderWith(
    mockReplying(verdict({ pass: false, reason: "It names the wrong person." }))
  );
  const graded = await grader.factuality(factInput);
  assert.equal(graded.pass, false);
  assert.equal(graded.notGraded, false);
  assert.equal(graded.reason, "It names the wrong person.");
});

test("a call reserves its estimate, then settles with the real cost", async () => {
  const model = mockReplying(verdict(), {
    cached: 400,
    input: 1000,
    output: 200,
  });
  const { grader, runDir } = graderWith(model);
  const graded = await grader.factuality(factInput);
  // 600 fresh input at $2/M, 400 cached at $0.20/M, 200 output at $10/M.
  const expected = (600 * 2 + 400 * 0.2 + 200 * 10) / 1_000_000;
  close(graded.costUsd ?? -1, expected);
  const after = totals(runDir);
  assert.equal(after.calls, 1);
  assert.equal(after.reservedUsd, 0);
  close(after.spentUsd, expected);
  assert.equal(after.byModel[MODEL_ID].calls, 1);
});

test("the estimate is prompt characters over four at the input price plus the output cap", async () => {
  const { grader, runDir } = graderWith(mockReplying(verdict()));
  await grader.factuality({ ...factInput, context: "x".repeat(4000) });
  const lines = readFileSync(join(runDir, LEDGER_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reserved = lines.find((line) => line.type === "reserve");
  assert.ok(reserved);
  const promptChars =
    RUBRICS.factuality.length +
    4000 +
    [
      "Reference (the answer key):\nThe author is engaged to Jordan.",
      "Output to grade:\nJordan is your fiancé.",
    ].join("\n\n").length;
  const expected =
    ((promptChars / 4) * 2 + DEFAULT_MAX_OUTPUT_TOKENS * 10) / 1_000_000;
  close(reserved.estimateUsd, expected);
  assert.equal(reserved.label, factInput.label);
});

test("the request is cold, capped, tagged, and ordered for caching", async () => {
  const model = mockReplying(verdict());
  const { grader } = graderWith(model, { maxOutputTokens: 1234 });
  await grader.factuality({
    ...factInput,
    context: "FACT SHEET AND JOURNAL",
    question: "Who am I engaged to?",
    transcript: "TRANSCRIPT AND TOOL RESULTS",
  });
  assert.equal(model.doGenerateCalls.length, 1);
  const [call] = model.doGenerateCalls;
  assert.equal(call.temperature, 0);
  assert.equal(call.maxOutputTokens, 1234);
  assert.deepEqual(call.providerOptions?.gateway?.tags, [
    "sage-eval",
    "sweep-1",
  ]);

  const [system, user] = call.prompt;
  assert.equal(system.role, "system");
  assert.equal(system.content, RUBRICS.factuality);
  assert.equal(user.role, "user");
  const parts = (user.content as { text: string; type: string }[]).map(
    (part) => part.text
  );
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "FACT SHEET AND JOURNAL");
  assert.equal(parts[1], "TRANSCRIPT AND TOOL RESULTS");
  assert.match(parts[2], whoAmIEngagedPattern);
  assert.match(parts[2], referenceTheAnswerKeyPattern);
  assert.match(parts[2], outputToGradeJordanPattern);
  assert.ok(
    parts[2].indexOf("Reference") < parts[2].indexOf("Output to grade"),
    "the reference comes before the output"
  );
});

test("a prompt with no context or transcript has only the item", async () => {
  const model = mockReplying(verdict());
  const { grader } = graderWith(model);
  await grader.factuality(factInput);
  const [, user] = model.doGenerateCalls[0].prompt;
  assert.equal((user.content as unknown[]).length, 1);
});

test("summary and extraction use their own rubric", async () => {
  const model = mockReplying(verdict());
  const { grader } = graderWith(model);
  await grader.summary({
    label: "summary-quality",
    output: "A short summary.",
    reference: "The author started a new job.",
  });
  await grader.extraction({
    current: "Biscuit has died.",
    label: "current-state",
    output: "Biscuit: a dog",
    stale: "Biscuit is a dog.",
  });
  assert.equal(model.doGenerateCalls[0].prompt[0].content, RUBRICS.summary);
  assert.equal(model.doGenerateCalls[1].prompt[0].content, RUBRICS.extraction);
  const extractionItem = (
    model.doGenerateCalls[1].prompt[1].content as { text: string }[]
  )[0].text;
  assert.match(extractionItem, currentFactFromThePattern);
  assert.match(extractionItem, staleFactNoLongerPattern);
});

test("the spending cap stops the call before the model is asked", async () => {
  const model = mockReplying(verdict());
  const { grader, runDir } = graderWith(model, { capUsd: 0.0001 });
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.equal(graded.pass, null);
  assert.equal(graded.reason, NOT_GRADED_SPENDING_CAP);
  assert.equal(graded.reason, "not graded: spending cap");
  assert.equal(model.doGenerateCalls.length, 0);
  assert.deepEqual(totals(runDir), {
    byModel: {},
    calls: 0,
    reservedUsd: 0,
    spentUsd: 0,
  });
});

test("money spent earlier counts against the cap", async () => {
  const runDir = tempRunDir();
  assert.ok(
    reserve(runDir, 1, { estimateUsd: 0.95, label: "earlier", model: "m" }).ok
  );
  const model = mockReplying(verdict());
  const { grader } = graderWith(model, { capUsd: 1, runDir });
  const graded = await grader.factuality(factInput);
  assert.equal(graded.reason, NOT_GRADED_SPENDING_CAP);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("a judge error is not graded, never a throw, and costs nothing", async () => {
  const { grader, runDir } = graderWith(mockThrowing(new Error("boom")));
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.equal(graded.pass, null);
  assert.match(graded.reason, notGradedJudgeErrorPattern);
  const after = totals(runDir);
  assert.equal(after.spentUsd, 0);
  assert.equal(after.reservedUsd, 0);
});

test("a timeout keeps its estimate reserved, because the work may have been billed", async () => {
  const timeout = new Error("The operation timed out");
  timeout.name = "TimeoutError";
  const { grader, runDir } = graderWith(mockThrowing(timeout));
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.ok(totals(runDir).reservedUsd > 0);
});

test("an answer that is not JSON is not graded, and its tokens are billed", async () => {
  const { grader, runDir } = graderWith(
    mockReplying("I think it is fine.", { input: 1000, output: 200 })
  );
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.match(graded.reason, notGradedJudgeError2Pattern);
  close(totals(runDir).spentUsd, (1000 * 2 + 200 * 10) / 1_000_000);
});

test("an answer that does not match the schema is not graded", async () => {
  const { grader } = graderWith(
    mockReplying(JSON.stringify({ evidence: "x", pass: "yes", reason: "y" }))
  );
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.equal(graded.pass, null);
});

test("an answer with a field missing is not graded", async () => {
  const { grader } = graderWith(
    mockReplying(JSON.stringify({ evidence: "x", reason: "y" }))
  );
  assert.equal((await grader.factuality(factInput)).notGraded, true);
});

test("a long error message is shortened in the reason", async () => {
  const { grader } = graderWith(mockThrowing(new Error("x".repeat(2000))));
  const graded = await grader.factuality(factInput);
  assert.ok(graded.reason.length < 400);
});

test("the cost the gateway reports wins over the computed cost", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve(
        generateResult(
          verdict(),
          { input: 1000, output: 200 },
          {
            gateway: { cost: "0.0042" },
          }
        )
      ),
  });
  const { grader, runDir } = graderWith(model);
  const graded = await grader.factuality(factInput);
  close(graded.costUsd ?? -1, 0.0042);
  close(totals(runDir).spentUsd, 0.0042);
});

test("a grader marked unavailable makes no call and says why", async () => {
  const model = mockReplying(verdict());
  const { grader, runDir } = graderWith(model, {
    unavailable: "not graded: no run directory",
  });
  const graded = await grader.factuality(factInput);
  assert.equal(graded.reason, "not graded: no run directory");
  assert.equal(model.doGenerateCalls.length, 0);
  assert.equal(totals(runDir).calls, 0);
});

test("judge runs any schema, which is how later PRs add reply and Dream grades", async () => {
  const schema = z.strictObject({ ok: z.boolean() });
  const model = mockReplying(JSON.stringify({ ok: true }));
  const { grader } = graderWith(model);
  const outcome = await grader.judge({
    instructions: "Say ok.",
    item: "Anything.",
    label: "custom",
    schema,
    schemaName: "custom_grade",
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.value, { ok: true });
    assert.deepEqual(outcome.usage, { inputTokens: 1000, outputTokens: 200 });
  }
});

test("judge returns a failure for a prompt it cannot price instead of calling the model", async () => {
  const runDir = tempRunDir();
  const model = mockReplying(verdict());
  const grader = createGrader({
    capUsd: 50,
    model,
    modelId: "nobody/unlisted",
    runDir,
    sweepId: "sweep-1",
  });
  mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ data: [], object: "list" }))
  );
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.match(graded.reason, notGradedNoPricePattern);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("rubricHash is ten hex characters and follows the rubric text", () => {
  const before = rubricHash();
  assert.match(before, setupIdPattern);
  assert.equal(rubricHash(), before);
  const original = RUBRICS.summary;
  (RUBRICS as { summary: string }).summary = `${original} Be strict.`;
  try {
    assert.notEqual(rubricHash(), before);
  } finally {
    (RUBRICS as { summary: string }).summary = original;
  }
  assert.equal(rubricHash(), before);
});

/** Runs `change` with the exported prompt titles changed, then puts them back. */
function withTitle(
  kind: keyof typeof ITEM_TITLES,
  name: string,
  title: string,
  change: () => void
): void {
  const titles = ITEM_TITLES[kind] as Record<string, string>;
  const original = titles[name];
  titles[name] = title;
  try {
    change();
  } finally {
    titles[name] = original;
  }
}

test("rubricHash changes with the output cap and the temperature", () => {
  const before = rubricHash();
  assert.equal(
    rubricHash({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS }),
    before
  );
  assert.equal(rubricHash({ temperature: JUDGE_TEMPERATURE }), before);
  assert.notEqual(rubricHash({ maxOutputTokens: 4096 }), before);
  assert.notEqual(rubricHash({ temperature: 0.7 }), before);
});

test("a grader's rubric follows the output cap it was built with", () => {
  const { grader: standard } = graderWith(mockReplying(verdict()));
  const { grader: short } = graderWith(mockReplying(verdict()), {
    maxOutputTokens: 512,
  });
  assert.equal(standard.rubric, rubricHash());
  assert.equal(short.rubric, rubricHash({ maxOutputTokens: 512 }));
  assert.notEqual(short.rubric, standard.rubric);
});

test("rubricHash changes with the title of any block in the item section", () => {
  const before = rubricHash();
  for (const [kind, name] of [
    ["extraction", "current"],
    ["extraction", "stale"],
    ["extraction", "output"],
    ["factuality", "question"],
    ["factuality", "reference"],
    ["factuality", "output"],
    ["summary", "reference"],
    ["summary", "output"],
    ["reply", "checks"],
    ["reply", "details"],
    ["reply", "message"],
    ["reply", "reference"],
    ["reply", "reply"],
    ["reply", "toolCalls"],
  ] as const) {
    withTitle(kind, name, "A different title", () => {
      assert.notEqual(rubricHash(), before, `${kind}.${name}`);
    });
    assert.equal(rubricHash(), before);
  }
});

test("the rubric hash material covers every part that shapes a grade", () => {
  const material = rubricMaterial();
  assert.deepEqual(Object.keys(material), [
    "answers",
    "dreamSourceLayout",
    "journalContext",
    "kinds",
    "maxOutputTokens",
    "reply",
    "rubrics",
    "temperature",
  ]);
  assert.deepEqual(material.rubrics, RUBRICS);
  assert.equal(material.journalContext, journalContextLayout());
  assert.equal(material.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(material.temperature, JUDGE_TEMPERATURE);
  assert.deepEqual(Object.keys(material.answers), [
    "conversation",
    "dreamSource",
    "factuality",
    "headToHead",
    "reply",
  ]);
  // The judge writes the fields in this order, so the order is part of the hash.
  assert.deepEqual(
    Object.keys(JSON.parse(material.answers.factuality).properties),
    ["evidence", "reason", "pass"]
  );
  assert.deepEqual(Object.keys(material.kinds), [
    "dreamSource",
    "extraction",
    "factuality",
    "reply",
    "summary",
  ]);
  for (const [kind, probe] of Object.entries(material.kinds)) {
    assert.equal(probe.instructions, RUBRICS[kind as RubricKind]);
    if (kind === "dreamSource") {
      continue;
    }
    assert.equal(probe.schemaName, `${kind}_grade`);
    assert.equal(probe.parts[0], "<fact sheet and journal>");
    if (kind !== "reply") {
      // The user message goes out as the fact sheet, the transcript, then the item.
      assert.equal(probe.parts[1], "<transcript>");
    }
    assert.equal(probe.parts[2], probe.item);
    assert.equal(probe.parts.length, 3);
  }
  const { dreamSource, extraction, factuality, summary } = material.kinds;
  // A Dream grade has no transcript: the fact sheet, then the source and what Dream wrote.
  assert.equal(dreamSource.schemaName, "dream_source_grade");
  assert.deepEqual(dreamSource.parts, [
    "<fact sheet and journal>",
    dreamSource.item,
  ]);
  assert.equal(
    dreamSource.item,
    "Source (a journal entry):\n<source>\n\nWhat the app wrote from this source:\n[summary]\n<written>"
  );
  assert.equal(
    extraction.item,
    [
      "Current fact (from the reference):\n<current>",
      "Stale fact (no longer true):\n<stale>",
      "Output: what the app remembers:\n<output>",
    ].join("\n\n")
  );
  assert.equal(
    factuality.item,
    [
      "Question the person asked:\n<question>",
      "Reference (the answer key):\n<reference>",
      "Output to grade:\n<output>",
    ].join("\n\n")
  );
  assert.equal(
    summary.item,
    [
      "Reference (what a good summary says):\n<reference>",
      "Output to grade:\n<output>",
    ].join("\n\n")
  );
});

test("the Dream-source rubric, schema, and prompt layout are inside the rubric hash", () => {
  const before = rubricHash();
  const original = RUBRICS.dreamSource;
  (RUBRICS as { dreamSource: string }).dreamSource = `${original} Be strict.`;
  try {
    assert.notEqual(rubricHash(), before);
  } finally {
    (RUBRICS as { dreamSource: string }).dreamSource = original;
  }
  assert.equal(rubricHash(), before);

  const material = rubricMaterial();
  assert.equal(material.rubrics.dreamSource, RUBRICS.dreamSource);
  // The judge writes the fields of a claim in this order, so the order is part of the hash.
  assert.deepEqual(
    Object.keys(
      JSON.parse(material.answers.dreamSource).properties.unsupportedClaims
        .items.properties
    ),
    ["itemKind", "itemText", "quote", "reason", "severity"]
  );
  // The layout covers both kinds of source, every kind of written item, and the fact sheet.
  const layout = material.dreamSourceLayout;
  for (const text of [
    "# Fact sheet for layout-probe",
    "Source (a journal entry):",
    "Source (a chat between User and Sage):",
    "What the app wrote from this source:",
    "[summary]",
    "[profile]",
    "[fact]",
    "[event]",
    "[chat-summary]",
    "[chat-title]",
    "(nobody listed)",
    "(nothing listed)",
  ]) {
    assert.ok(layout.includes(text), text);
  }
});

test("the Dream-source call is built from the same layout the rubric hash reads", () => {
  const source = {
    sourceId: "2026-09-03-lost-mia",
    sourceKind: "entry",
    sourceText: '2026-09-03, "Lost Mia"\n\nLost Mia today.',
    written: [{ itemKind: "summary", text: "Mia died today." }],
  } as const;
  const context = formatFactSheet({
    id: "sam",
    personCase: { about: "A test author.", cast: [], timeline: [] },
  });
  const call = dreamSourceCall({
    context,
    label: "dream-accuracy sam/dream/x",
    source: { ...source, written: [...source.written] },
  });
  assert.equal(call.instructions, RUBRICS.dreamSource);
  assert.equal(call.context, context);
  assert.equal(
    call.item,
    formatSourceForJudge({ ...source, written: [...source.written] })
  );
  assert.equal(call.schemaName, rubricMaterial().kinds.dreamSource.schemaName);
  assert.equal(call.transcript, undefined);
});

test("the prompts a grader sends are the ones the rubric hash was made from", async () => {
  const model = mockReplying(verdict());
  const { grader } = graderWith(model);
  await grader.factuality({
    context: "<fact sheet and journal>",
    label: "probe",
    output: "<output>",
    question: "<question>",
    reference: "<reference>",
    transcript: "<transcript>",
  });
  const [call] = model.doGenerateCalls;
  const sent = JSON.stringify(call.prompt);
  const { factuality } = rubricMaterial().kinds;
  for (const part of factuality.parts) {
    assert.ok(sent.includes(JSON.stringify(part).slice(1, -1)), part);
  }
  assert.ok(sent.indexOf("<fact sheet") < sent.indexOf("<transcript>"));
  assert.ok(sent.indexOf("<transcript>") < sent.indexOf("Question the person"));
  assert.equal(call.temperature, JUDGE_TEMPERATURE);
  assert.equal(call.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

test("the factuality schema asks for the quote first, then the reason, then the verdict", () => {
  assert.deepEqual(Object.keys(factualityGradeSchema.shape), [
    "evidence",
    "reason",
    "pass",
  ]);
});

// ---------------------------------------------------------------------------
// graderFromEnv
// ---------------------------------------------------------------------------

function sweepFile(sweep: Record<string, unknown>): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "sage-grader-sweep-")),
    "s.json"
  );
  writeFileSync(path, JSON.stringify(parseSweepFile(sweep)));
  return path;
}

test("graderFromEnv without a run directory grades nothing and says so", async () => {
  const grader = graderFromEnv({ [ENV_SWEEP_FILE]: sweepFile({}) });
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.match(graded.reason, notGradedNoRunPattern);
  assert.match(graded.reason, new RegExp(ENV_RUN_DIR, "u"));
});

test("graderFromEnv reports an unreadable sweep as not graded instead of throwing", async () => {
  const grader = graderFromEnv({
    [ENV_RUN_DIR]: tempRunDir(),
    [ENV_SWEEP_FILE]: join(tmpdir(), "sage-grader-missing", "sweep.json"),
  });
  const graded = await grader.factuality(factInput);
  assert.equal(graded.notGraded, true);
  assert.match(graded.reason, couldNotReadTheSweepPattern);
});

test("graderFromEnv does not need a setup id to read the judge settings", () => {
  const grader = graderFromEnv({
    [ENV_RUN_DIR]: tempRunDir(),
    [ENV_SWEEP_FILE]: sweepFile({
      chatModels: ["a", "b"],
      judge: { model: "acme/judge-2" },
    }),
  });
  assert.equal(grader.modelId, "acme/judge-2");
});

test("graderFromEnv takes the judge model and the cap from the sweep file", async () => {
  const requested: string[] = [];
  mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    requested.push(String(input));
    return Promise.resolve(
      Response.json({
        data: [
          {
            id: "acme/judge-1",
            pricing: { input: "0.000001", output: "0.000002" },
          },
        ],
        object: "list",
      })
    );
  });
  const runDir = tempRunDir();
  const grader = graderFromEnv({
    [ENV_RUN_DIR]: runDir,
    [ENV_SWEEP_FILE]: sweepFile({
      judge: { model: "acme/judge-1" },
      spendingCapUsd: 0,
    }),
  });
  assert.equal(grader.modelId, "acme/judge-1");
  const graded = await grader.factuality(factInput);
  assert.equal(graded.reason, NOT_GRADED_SPENDING_CAP);
  assert.deepEqual(requested, ["https://ai-gateway.vercel.sh/v1/models"]);
  // The price is saved in the run directory for the other eval processes.
  assert.match(
    readFileSync(join(runDir, "prices.json"), "utf8"),
    acmeJudge1Pattern
  );
});
