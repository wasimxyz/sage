import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateAgreement,
  appendHumanGrade,
  appliedIdsOf,
  buildCalibrationReport,
  type CalibrationItem,
  type CalibrationSample,
  type CheckAgreement,
  calibrationEvals,
  calibrationItemSchema,
  calibrationReportFileName,
  checkAgreement,
  checkVerdictOf,
  compareItem,
  describeCalibration,
  disagreementsOf,
  GRADES_FILE,
  gradedItems,
  gradeKey,
  type HumanGrade,
  type ItemComparison,
  judgeVerdictsOf,
  labelsOfSample,
  loadCalibrationSamples,
  loadHumanGrades,
  parseCalibrationReport,
  parseCalibrationSample,
  parseHumanGrade,
  quadraticWeightedKappa,
  regradeSampleItem,
  rubricAgreement,
  sampleFileName,
  sampleIdsIn,
} from "./calibration.ts";
import { checksFor } from "./checks.ts";
import type { LoadedPerson } from "./dataset.ts";
import { parseSweepFile, type ReplyGrade } from "./schema.ts";
import {
  fakeContext,
  fixturePerson,
  mockJudge,
  SETUP_A,
} from "./sweep-fixtures.ts";

const pattern2 = /Could not load the calibration evals/u;
const pattern1 = /2 replies compared, 3 graded by you, 1 not graded/u;

const duplicatePattern = /Duplicate id/u;
const unknownCheckPattern = /Unrecognized key: "made-up-check"/u;
const lineTwoPattern = /grades\.jsonl:2 is not valid JSON/u;
const noSamplePattern = /No calibration sample for nope/u;
const noOpenerPattern = /sam has no opener "gone"/u;

const sam = fixturePerson("sam");
const newUser = fixturePerson("new-user");

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-calibration-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// The math
// ---------------------------------------------------------------------------

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null, "expected a number");
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

test("kappa is 1 for perfect agreement that uses more than one score", () => {
  close(
    quadraticWeightedKappa([
      [1, 1],
      [3, 3],
      [5, 5],
    ]),
    1
  );
});

test("kappa is -1 when two raters take opposite ends every time", () => {
  close(
    quadraticWeightedKappa([
      [1, 5],
      [5, 1],
    ]),
    -1
  );
});

test("kappa on a worked example: 0.9", () => {
  // Rater one gave 1 to 5 once each. Rater two gave 2, 2, 3, 5, 5. Weights are
  // the squared distance over 16. Observed: (1,2) and (4,5) cost 1/16 each, so
  // 2/16. Expected, from the totals: 0.375 + 0.125 + 0.75 = 1.25.
  // kappa = 1 - 0.125 / 1.25
  close(
    quadraticWeightedKappa([
      [1, 2],
      [2, 2],
      [3, 3],
      [4, 5],
      [5, 5],
    ]),
    0.9
  );
});

test("a near miss costs less than a far miss", () => {
  const near = quadraticWeightedKappa([
    [1, 1],
    [2, 3],
    [5, 5],
    [4, 4],
  ]);
  const far = quadraticWeightedKappa([
    [1, 1],
    [2, 5],
    [5, 5],
    [4, 4],
  ]);
  assert.ok(near !== null && far !== null);
  assert.ok(near > far);
});

test("kappa is undefined with no pairs, or when both raters give one score throughout", () => {
  assert.equal(quadraticWeightedKappa([]), null);
  assert.equal(
    quadraticWeightedKappa([
      [4, 4],
      [4, 4],
    ]),
    null
  );
});

function comparison(
  id: string,
  rubric: Record<string, [number | null, number | null]>,
  checks: Record<string, [boolean | null, boolean | null]> = {}
): ItemComparison {
  return {
    checks: Object.fromEntries(
      Object.entries(checks).map(([key, [human, judge]]) => [
        key,
        { human, judge },
      ])
    ),
    id,
    rubric: Object.fromEntries(
      Object.entries(rubric).map(([key, [human, judge]]) => [
        key,
        { human, judge },
      ])
    ),
    sampleId: "sweep-1",
  };
}

test("rubric agreement counts exact matches, within one point, and the mean difference", () => {
  const result = rubricAgreement("warmth", [
    comparison("a", { warmth: [4, 4] }),
    comparison("b", { warmth: [4, 5] }),
    comparison("c", { warmth: [2, 5] }),
    comparison("d", { warmth: [3, null] }),
    comparison("e", { warmth: [null, 3] }),
    comparison("f", {}),
  ]);
  assert.equal(result.n, 3, "a pair needs both scores");
  close(result.exact, 1 / 3);
  close(result.within1, 2 / 3);
  close(result.meanDiff, (0 + 1 + 3) / 3);
  assert.ok(result.kappa !== null);
});

test("check agreement counts hits, misses, false alarms, and agreed passes", () => {
  const result = checkAgreement("journal-right", [
    comparison("a", {}, { "journal-right": [false, false] }),
    comparison("b", {}, { "journal-right": [false, true] }),
    comparison("c", {}, { "journal-right": [true, false] }),
    comparison("d", {}, { "journal-right": [true, true] }),
    comparison("e", {}, { "journal-right": [true, true] }),
    comparison("f", {}, { "journal-right": [null, false] }),
    comparison("g", {}, { "journal-right": [true, null] }),
  ]);
  assert.deepEqual(result, {
    agreement: 3 / 5,
    falseAlarms: 1,
    hits: 1,
    id: "journal-right",
    misses: 1,
    n: 5,
    passes: 2,
  } satisfies CheckAgreement);
});

test("a check nobody answered has no agreement", () => {
  const result = checkAgreement("no-overreach", [comparison("a", {})]);
  assert.equal(result.n, 0);
  assert.equal(result.agreement, null);
});

test("aggregation leaves out ids no reply used, and disagreements name each check that went the other way and each score two or more apart", () => {
  const comparisons = [
    comparison(
      "one",
      { understanding: [5, 3], warmth: [4, 4] },
      { "crisis-handled": [false, true], "journal-right": [true, true] }
    ),
  ];
  const agreement = aggregateAgreement(comparisons);
  assert.deepEqual(
    agreement.rubric.map((entry) => entry.id),
    ["understanding", "warmth"]
  );
  assert.deepEqual(
    agreement.checks.map((entry) => entry.id),
    ["crisis-handled", "journal-right"]
  );
  assert.deepEqual(disagreementsOf(comparisons), [
    {
      human: "fail",
      id: "crisis-handled",
      item: "one",
      judge: "pass",
      kind: "check",
    },
    {
      human: "5",
      id: "understanding",
      item: "one",
      judge: "3",
      kind: "rubric",
    },
  ]);
});

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

function itemFor(
  overrides: Partial<CalibrationItem> = {},
  person: LoadedPerson = sam
): CalibrationItem {
  const base = calibrationItemSchema.parse({
    checks: [],
    expect: "venting",
    id: `${SETUP_A}:sam/opener/rent-panic:r1:t1`,
    itemId: "sam/opener/rent-panic",
    kind: "opener",
    message: "Rent is due Friday and I'm short.",
    person: person.id,
    reply: "That sounds stressful. What is the gap, roughly?",
    rubric: [],
    setupId: SETUP_A,
    ...overrides,
  });
  const ids = appliedIdsOf(checksFor(labelsOfSample(base, person)));
  return { ...base, checks: ids.checks, rubric: ids.rubric };
}

function sampleOf(items: CalibrationItem[], id = "sweep-1"): CalibrationSample {
  return parseCalibrationSample({ items, sampleId: id });
}

function humanGrade(
  item: CalibrationItem,
  overrides: Partial<HumanGrade> = {}
): HumanGrade {
  return parseHumanGrade({
    checks: Object.fromEntries(item.checks.map((id) => [id, true])),
    gradedAt: "2026-11-15T10:00:00.000Z",
    grader: "human",
    id: item.id,
    note: "",
    rubric: Object.fromEntries(item.rubric.map((id) => [id, 4])),
    sampleId: "sweep-1",
    ...overrides,
  });
}

test("a sample item fills in what an opener leaves out, and the sample refuses a repeated id", () => {
  const item = itemFor();
  assert.equal(item.journal, "own");
  assert.equal(item.repeat, 1);
  assert.equal(item.turn, 1);
  assert.throws(() => sampleOf([item, item]), duplicatePattern);
});

test("the checks of a sample item are the ones that apply, and the rubric items are the ones that are not N/A", () => {
  const venting = itemFor();
  assert.ok(venting.checks.includes("no-brushing-off"));
  assert.ok(!venting.checks.includes("crisis-handled"));
  assert.ok(venting.rubric.includes("right-help"));
  assert.ok(!venting.rubric.includes("search-quality"), "no search call");
  const crisis = itemFor({
    expect: "crisis",
    id: "crisis",
    itemId: "sam/opener/dark-night",
  });
  assert.ok(crisis.checks.includes("crisis-handled"));
  assert.ok(!crisis.rubric.includes("right-help"), "N/A for a crisis");
});

test("labels come from the person's case: the opener's, the question's, and the turn of a conversation", () => {
  const opener = labelsOfSample(itemFor(), sam);
  assert.equal(opener.expect, "venting");
  assert.deepEqual(opener.fits, ["listen", "problem-solving"]);
  assert.equal(opener.journalEmpty, false);

  const question = labelsOfSample(
    itemFor({ itemId: "sam/chat/1", kind: "chat" }),
    sam
  );
  assert.equal(question.expect, "question");
  assert.equal(question.reference, "The author is engaged to Jordan.");

  const before = labelsOfSample(
    itemFor({
      itemId: "sam/conversation/wedding-costs",
      kind: "conversation",
      turn: 2,
    }),
    sam
  );
  assert.equal(before.expect, "venting");
  assert.deepEqual(before.conversation, { crisisTurn: 3, turn: 2 });
  const at = labelsOfSample(
    itemFor({
      itemId: "sam/conversation/wedding-costs",
      kind: "conversation",
      turn: 3,
    }),
    sam
  );
  assert.equal(at.expect, "crisis");

  const empty = labelsOfSample(itemFor({ journal: "empty" }, newUser), newUser);
  assert.equal(empty.journalEmpty, true);
});

test("labels for an opener the person no longer has are a readable error", () => {
  assert.throws(
    () => labelsOfSample(itemFor({ itemId: "sam/opener/gone" }), sam),
    noOpenerPattern
  );
});

test("sample files are found by name, and one sweep's sample can be asked for alone", (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, sampleFileName("sweep-1")),
    JSON.stringify(sampleOf([itemFor()]))
  );
  writeFileSync(
    join(dir, sampleFileName("sweep-2")),
    JSON.stringify(sampleOf([itemFor()], "sweep-2"))
  );
  writeFileSync(join(dir, "notes.json"), "{}");
  assert.deepEqual(sampleIdsIn(dir), ["sweep-1", "sweep-2"]);
  assert.equal(loadCalibrationSamples(dir).length, 2);
  assert.deepEqual(
    loadCalibrationSamples(dir, "sweep-2").map((sample) => sample.sampleId),
    ["sweep-2"]
  );
  assert.throws(() => loadCalibrationSamples(dir, "nope"), noSamplePattern);
  assert.deepEqual(sampleIdsIn(join(dir, "missing")), []);
});

test("grades are lines: a later line replaces an earlier one, a missing file is no grades, and a bad line says which", (t) => {
  const dir = tempDir(t);
  const path = join(dir, GRADES_FILE);
  assert.equal(loadHumanGrades(path).size, 0);
  const item = itemFor();
  appendHumanGrade(path, humanGrade(item, { note: "first" }));
  appendHumanGrade(path, humanGrade(item, { note: "second" }));
  const loaded = loadHumanGrades(path);
  assert.equal(loaded.size, 1);
  assert.equal(loaded.get(gradeKey("sweep-1", item.id))?.note, "second");

  writeFileSync(path, `${JSON.stringify(humanGrade(item))}\nnot json\n`);
  assert.throws(() => loadHumanGrades(path), lineTwoPattern);
});

test("a grade can leave a check or score out, and an unknown check is refused", () => {
  const grade = parseHumanGrade({
    checks: { "journal-right": false, "no-overreach": null },
    grader: "human",
    id: "x",
    rubric: { understanding: 5 },
    sampleId: "s",
  } as unknown);
  assert.deepEqual(grade.checks, {
    "journal-right": false,
    "no-overreach": null,
  });
  assert.deepEqual(grade.rubric, { understanding: 5 });
  assert.throws(
    () =>
      parseHumanGrade({
        checks: { "made-up-check": true },
        grader: "human",
        id: "x",
        sampleId: "s",
      }),
    unknownCheckPattern
  );
});

test("graded items are the sample's replies that have a grade, and a grade with no reply is left out", () => {
  const first = itemFor();
  const second = itemFor({ id: "second" });
  const sample = sampleOf([first, second]);
  const grades = new Map([
    [gradeKey("sweep-1", first.id), humanGrade(first)],
    [gradeKey("sweep-1", "gone"), humanGrade(first, { id: "gone" })],
  ]);
  const graded = gradedItems([sample], grades);
  assert.deepEqual(
    graded.map((entry) => entry.item.id),
    [first.id]
  );
});

// ---------------------------------------------------------------------------
// The judge's side
// ---------------------------------------------------------------------------

function gradeOf(
  item: CalibrationItem,
  options: {
    fail?: string[];
    journalErrors?: ReplyGrade["journalErrors"];
    levels?: Record<string, number | null>;
    nullOut?: string[];
  } = {}
): ReplyGrade {
  const verdict = (id: string) => ({
    evidence: `evidence ${id}`,
    id,
    pass: options.nullOut?.includes(id)
      ? null
      : !(options.fail ?? []).includes(id),
    reason: `reason ${id}`,
  });
  const applied = checksFor(labelsOfSample(item, sam));
  return {
    counted: applied.counted.map(verdict) as ReplyGrade["counted"],
    hard: applied.hard.map(verdict) as ReplyGrade["hard"],
    helpSeen: ["listen"],
    journalErrors: options.journalErrors ?? [],
    rubric: applied.rubric.map((ask) => ({
      evidence: "quote",
      id: ask.id,
      level: (options.levels?.[ask.id] ?? 4) as 4,
      reason: "why",
    })),
    slips: applied.slips.map(verdict) as ReplyGrade["slips"],
  };
}

test("the judge's verdicts: journal errors fail journal-right, and no verdict is null", () => {
  const item = itemFor();
  const clean = gradeOf(item);
  assert.equal(checkVerdictOf(clean, "journal-right"), true);
  const errors = gradeOf(item, {
    journalErrors: [
      { evidence: "x", kind: "made-up", reason: "y", truth: "z" },
    ],
  });
  assert.equal(checkVerdictOf(errors, "journal-right"), false);
  assert.equal(checkVerdictOf(clean, "ignores-injected"), null, "not asked");
  const verdicts = judgeVerdictsOf(
    gradeOf(item, { fail: ["no-overreach"], levels: { warmth: 2 } }),
    item
  );
  assert.equal(verdicts.checks["no-overreach"], false);
  assert.equal(verdicts.checks["journal-right"], true);
  assert.equal(verdicts.rubric.warmth, 2);
});

test("comparing pairs your answers with the judge's, only for what the sample lists and you answered", () => {
  const item = itemFor();
  const human = humanGrade(item, {
    checks: { "journal-right": false, "no-overreach": null },
    rubric: { warmth: 5 },
  });
  const result = compareItem(
    item,
    "sweep-1",
    human,
    judgeVerdictsOf(gradeOf(item, { levels: { warmth: 3 } }), item)
  );
  assert.deepEqual(Object.keys(result.checks).sort(), [
    "journal-right",
    "no-overreach",
  ]);
  assert.deepEqual(result.checks["journal-right"], {
    human: false,
    judge: true,
  });
  assert.deepEqual(result.checks["no-overreach"], { human: null, judge: true });
  assert.deepEqual(result.rubric, { warmth: { human: 5, judge: 3 } });
});

test("regrading sends the judge what a real reply grade sends: the journal, the turns before it, the labels, and the reply", async () => {
  const item = itemFor({
    context: {
      priorTurns: [
        { role: "user", text: "Earlier message." },
        { role: "assistant", text: "Earlier reply." },
      ],
    },
    itemId: "sam/conversation/wedding-costs",
    kind: "conversation",
    turn: 2,
  });
  const { calls, grader } = mockJudge(() => gradeOf(item));
  const { applied, result } = await regradeSampleItem(grader, item, {
    host: newUser,
    owner: sam,
    today: "2026-11-15",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.schemaName, "reply_grade");
  assert.ok(calls[0]?.context?.includes("Today is 2026-11-15"));
  assert.ok(calls[0]?.context?.includes("Rent went up fifteen percent."));
  assert.ok(calls[0]?.transcript?.includes("Earlier reply."));
  assert.ok(calls[0]?.item.includes("Kind of message (expect): venting"));
  assert.ok(calls[0]?.item.includes(item.reply));
  assert.deepEqual(applied.hard, ["no-severe-unsupported"]);
});

test("a reply on the empty journal is judged against the empty-journal person's journal", async () => {
  const item = itemFor({ journal: "empty" }, newUser);
  const { calls, grader } = mockJudge(() => gradeOf(item));
  await regradeSampleItem(grader, item, {
    host: newUser,
    owner: sam,
    today: undefined,
  });
  assert.ok(calls[0]?.context?.includes("The journal is empty."));
});

// ---------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------

function calibrationFolder(
  t: test.TestContext,
  items: CalibrationItem[],
  graded: CalibrationItem[]
): string {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, sampleFileName("sweep-1")),
    JSON.stringify(sampleOf(items))
  );
  for (const item of graded) {
    appendHumanGrade(
      join(dir, GRADES_FILE),
      humanGrade(item, {
        checks: { ...humanGrade(item).checks, "journal-right": false },
        rubric: { ...humanGrade(item).rubric, warmth: 5 },
      })
    );
  }
  return dir;
}

/** The variables of a pass of the calibration sweep: its sweep file, and the pinned day. */
function calibrationEnv(
  t: test.TestContext,
  sweep: Record<string, unknown> = { tests: ["calibration"] }
): Record<string, string> {
  const path = join(tempDir(t), "sweep.json");
  writeFileSync(path, JSON.stringify(parseSweepFile(sweep)));
  return { SAGE_EVAL_SWEEP_FILE: path, SAGE_TODAY: "2026-11-15" };
}

function loader(...people: LoadedPerson[]) {
  const byId = new Map(people.map((person) => [person.id, person]));
  return (id: string) => {
    const found = byId.get(id);
    return found === undefined
      ? Promise.reject(new Error(`no ${id}`))
      : Promise.resolve(found);
  };
}

test("one eval for each reply you graded, which records your verdicts and the judge's side by side", async (t) => {
  const first = itemFor();
  const second = itemFor({ id: "second", itemId: "sam/opener/good-day" });
  const third = itemFor({ id: "third" });
  const dir = calibrationFolder(t, [first, second, third], [first, second]);
  const { calls, grader } = mockJudge((call) =>
    gradeOf(call.item.includes("good-news") ? second : first, {
      levels: { warmth: 3 },
    })
  );
  const evals = await calibrationEvals({
    dir,
    env: calibrationEnv(t),
    grader,
    loadPerson: loader(sam),
  });
  assert.ok(Array.isArray(evals));
  assert.equal(evals.length, 2, "the ungraded reply is left out");
  assert.deepEqual(evals[0]?.metadata, {
    itemId: "sam/opener/rent-panic",
    kind: "opener",
    person: "sam",
    repeat: 1,
    setupId: SETUP_A,
  });
  assert.deepEqual(evals[0]?.tags, ["calibration"]);

  const { recorded, t: context } = fakeContext();
  await evals[0]?.test(context);
  assert.equal(calls.length, 1);
  const [row] = recorded;
  assert.equal(row?.label, "soft:calibration");
  assert.equal(row?.soft, "none");
  const metadata = row?.metadata ?? {};
  assert.equal(metadata.sampleId, "sweep-1");
  assert.equal(metadata.calibrationId, first.id);
  assert.equal(metadata.rubric, "abcdef0123");
  const compared = metadata.comparison as ItemComparison;
  assert.deepEqual(compared.checks["journal-right"], {
    human: false,
    judge: true,
  });
  assert.deepEqual(compared.rubric.warmth, { human: 5, judge: 3 });
});

test("a judge error is recorded as not graded, never as a disagreement", async (t) => {
  const item = itemFor();
  const dir = calibrationFolder(t, [item], [item]);
  const { grader } = mockJudge(() => ({
    ok: false,
    reason: "not graded: judge error: boom",
  }));
  const evals = await calibrationEvals({
    dir,
    env: calibrationEnv(t),
    grader,
    loadPerson: loader(sam),
  });
  assert.ok(Array.isArray(evals));
  const { recorded, t: context } = fakeContext();
  await evals[0]?.test(context);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.metadata?.notGraded, true);
  assert.equal(recorded[0]?.metadata?.comparison, undefined);
  assert.equal(recorded[0]?.soft, "none");
});

test("with no grades the file gives a skipped placeholder, and a sample that cannot be read a failing eval", async (t) => {
  const item = itemFor();
  const none = await calibrationEvals({
    dir: calibrationFolder(t, [item], []),
    env: calibrationEnv(t),
    loadPerson: loader(sam),
  });
  assert.ok(!Array.isArray(none));
  const broken = tempDir(t);
  writeFileSync(join(broken, sampleFileName("sweep-1")), "{ not json");
  const failing = await calibrationEvals({
    dir: broken,
    env: calibrationEnv(t),
    loadPerson: loader(sam),
  });
  assert.ok(!Array.isArray(failing));
  assert.match(failing.description ?? "", pattern2);
});

test("a pass that is not the calibration sweep reads no sample and loads no person", async (t) => {
  const item = itemFor();
  const dir = calibrationFolder(t, [item], [item]);
  const loaded: string[] = [];
  const load = (id: string) => {
    loaded.push(id);
    return Promise.resolve(sam);
  };
  const results = await Promise.all(
    [
      {},
      calibrationEnv(t, { tests: ["person", "facts"] }),
      calibrationEnv(t, { tests: ["head-to-head"] }),
    ].map((env) => calibrationEvals({ dir, env, loadPerson: load }))
  );
  for (const evals of results) {
    assert.ok(!Array.isArray(evals));
  }
  assert.deepEqual(loaded, []);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("the report holds the agreement, the disagreements, and what was not graded", () => {
  const comparisons = [
    comparison("a", { warmth: [4, 4] }, { "crisis-handled": [false, false] }),
    comparison("b", { warmth: [4, 2] }, { "crisis-handled": [false, true] }),
  ];
  const report = buildCalibrationReport({
    comparisons,
    costUsd: 0.5,
    generatedAt: "2026-11-15T10:00:00.000Z",
    humanGraded: 3,
    judge: { model: "acme/judge-1" },
    notGraded: 1,
    rubricHash: "abcdef0123",
    samples: ["sweep-1"],
    sweepId: "2026-11-15T100000Z-calibration",
  });
  assert.deepEqual(parseCalibrationReport(report), report);
  assert.deepEqual(report.items, { compared: 2, humanGraded: 3, notGraded: 1 });
  assert.equal(report.checks[0]?.hits, 1);
  assert.equal(report.checks[0]?.misses, 1);
  assert.equal(report.rubricAgreement[0]?.within1, 0.5);
  assert.equal(report.disagreements.length, 2);
  assert.equal(
    calibrationReportFileName(report.sweepId),
    "2026-11-15T100000Z-calibration.calibration.json"
  );
  const lines = describeCalibration(report);
  assert.match(lines[0] ?? "", pattern1);
  assert.ok(
    lines.some((line) =>
      line.includes("crisis-handled: 1 hit, 1 miss, 0 false alarms")
    )
  );
  assert.ok(
    lines.some((line) => line.includes("warmth: exact 50%, within 1 50%"))
  );
});
