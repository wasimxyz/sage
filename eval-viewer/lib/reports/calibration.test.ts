import assert from "node:assert/strict";
import test from "node:test";

import {
  type CalibrationSample,
  contextLabel,
  contextTurns,
  draftFromGrade,
  emptyDraft,
  gradesBySample,
  type HumanGrade,
  itemState,
  maxNoteLength,
  parseCalibrationSample,
  parseGradeLine,
  parseGrades,
  sampleFilePattern,
  sampleProgress,
  serializeGrade,
  upsertGradeText,
  validateGradeInput,
} from "./calibration.ts";
import { sampleCalibration } from "./sweep-samples.ts";

function sample(): CalibrationSample {
  const outcome = parseCalibrationSample(JSON.stringify(sampleCalibration()));
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    throw new Error("unreachable");
  }
  return outcome.value;
}

function assertHas(text: string, part: string): void {
  assert.ok(text.includes(part), `"${part}" is not in "${text}"`);
}

function grade(overrides: Partial<HumanGrade> = {}): HumanGrade {
  return {
    checks: { "crisis-handled": true, "no-overreach": false },
    gradedAt: "2026-11-16T10:00:00.000Z",
    grader: "human",
    id: "c01",
    note: "diagnosis",
    rubric: { "right-help": null, warmth: 4 },
    sampleId: "sample-2026-11-16",
    ...overrides,
  };
}

test("a calibration sample is read with its items, context, and ids", () => {
  const { items, sampleId } = sample();
  assert.equal(sampleId, "sample-2026-11-16");
  assert.equal(items.length, 3);
  assert.deepEqual(items[0]?.checks, ["crisis-handled", "no-overreach"]);
  assert.deepEqual(items[0]?.rubric, ["warmth", "right-help"]);
  assert.equal(items[0]?.expect, "venting");
  assert.equal(items[0]?.person, "engaged");
  assert.deepEqual(Object.keys(items[0]?.context ?? {}), [
    "factSheet",
    "history",
  ]);
  assert.equal(items[1]?.context, undefined);
});

test("a calibration sample is tolerant of what it does not know or lacks", () => {
  const outcome = parseCalibrationSample(
    JSON.stringify({
      extra: true,
      items: [
        { id: 7, reply: "Hi." },
        { context: "not an object", id: "b", surprise: 1 },
      ],
      sampleId: "s",
    })
  );
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    return;
  }
  assert.deepEqual(outcome.value.items[0], {
    checks: [],
    context: undefined,
    expect: "",
    id: "7",
    itemId: "",
    kind: "",
    message: "",
    person: "",
    reply: "Hi.",
    rubric: [],
    setupId: "",
  });
  assert.equal(outcome.value.items[1]?.context, undefined);
});

test("a calibration sample that is wrong names the problem", () => {
  const message = (raw: string) => {
    const outcome = parseCalibrationSample(raw);
    return outcome.kind === "ok" ? "" : outcome.message;
  };
  assertHas(message("{"), "not valid JSON");
  assertHas(message("[]"), "expected an object");
  assertHas(message(JSON.stringify({ items: [] })), "sampleId");
  assertHas(
    message(JSON.stringify({ sampleId: "s" })),
    "items: expected a list"
  );
  assertHas(
    message(JSON.stringify({ items: [{ reply: "x" }], sampleId: "s" })),
    "items[0].id"
  );
  assertHas(
    message(
      JSON.stringify({ items: [{ id: "a" }, { id: "a" }], sampleId: "s" })
    ),
    '"a" is used twice'
  );
});

test("contextLabel turns a key into words", () => {
  assert.equal(contextLabel("factSheet"), "Fact sheet");
  assert.equal(contextLabel("past_chats"), "Past chats");
  assert.equal(contextLabel("journal-excerpt"), "Journal excerpt");
  assert.equal(contextLabel("history"), "History");
  assert.equal(contextLabel("___"), "___");
});

test("contextTurns reads a list of messages and nothing else", () => {
  assert.deepEqual(
    contextTurns([
      { role: "user", text: "Hi" },
      { content: "Hello", role: "assistant" },
    ]),
    [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello" },
    ]
  );
  assert.equal(contextTurns([]), undefined);
  assert.equal(contextTurns("text"), undefined);
  assert.equal(contextTurns([{ role: "user" }]), undefined);
  assert.equal(contextTurns([{ role: "user", text: "a" }, "b"]), undefined);
});

test("sample file names must look like sample-<name>.json", () => {
  assert.equal(sampleFilePattern.test("sample-2026-11-16.json"), true);
  assert.equal(sampleFilePattern.test("grades.jsonl"), false);
  assert.equal(sampleFilePattern.test("../sample-x.json"), false);
  assert.equal(sampleFilePattern.test("sample-x/../y.json"), false);
  assert.equal(sampleFilePattern.test("sample-.json"), false);
});

test("a grade line is read and a line that is not a human grade is skipped", () => {
  const line = serializeGrade(grade());
  assert.deepEqual(parseGradeLine(line), grade());
  assert.equal(parseGradeLine("not json"), undefined);
  assert.equal(parseGradeLine("[]"), undefined);
  assert.equal(parseGradeLine(JSON.stringify({ id: "a" })), undefined);
  assert.equal(
    parseGradeLine(JSON.stringify({ grader: "judge", id: "a", sampleId: "s" })),
    undefined
  );
  // A line with no grader is a human grade. Values of the wrong type are dropped.
  assert.deepEqual(
    parseGradeLine(
      JSON.stringify({
        checks: { a: true, b: "yes", c: null },
        id: 3,
        rubric: { a: 6, b: 0, c: 5, d: null, e: 2.5 },
        sampleId: "s",
      })
    ),
    {
      checks: { a: true, c: null },
      gradedAt: "",
      grader: "human",
      id: "3",
      note: "",
      rubric: { c: 5, d: null },
      sampleId: "s",
    }
  );
});

test("serializeGrade writes the keys in the file's order", () => {
  assert.equal(
    serializeGrade(grade({ checks: { a: true }, rubric: { b: 5 } })),
    '{"sampleId":"sample-2026-11-16","id":"c01","grader":"human","checks":{"a":true},"rubric":{"b":5},"note":"diagnosis","gradedAt":"2026-11-16T10:00:00.000Z"}'
  );
});

test("parseGrades skips blank and broken lines, and a later line wins in gradesBySample", () => {
  const text = [
    serializeGrade(grade({ note: "first" })),
    "",
    "broken",
    serializeGrade(grade({ note: "second" })),
    serializeGrade(grade({ id: "c02", sampleId: "other" })),
  ].join("\n");
  const grades = parseGrades(text);
  assert.equal(grades.length, 3);
  const mine = gradesBySample(grades, "sample-2026-11-16");
  assert.equal(mine.size, 1);
  assert.equal(mine.get("c01")?.note, "second");
  assert.equal(gradesBySample(grades, "other").get("c02")?.id, "c02");
});

test("upsertGradeText replaces a grade in place and keeps every other line as it was", () => {
  const unreadable = "this line is not json";
  const judge = JSON.stringify({ grader: "judge", id: "c01", sampleId: "x" });
  const first = serializeGrade(grade({ id: "c01", note: "old" }));
  const other = serializeGrade(grade({ id: "c02" }));
  const raw = `${first}\n${unreadable}\n${judge}\n${other}\n`;
  const next = upsertGradeText(raw, grade({ id: "c01", note: "new" }));
  assert.deepEqual(next.split("\n"), [
    serializeGrade(grade({ id: "c01", note: "new" })),
    unreadable,
    judge,
    other,
    "",
  ]);
});

test("upsertGradeText adds a new grade at the end, and starts a file from nothing", () => {
  assert.equal(upsertGradeText("", grade()), `${serializeGrade(grade())}\n`);
  const raw = `${serializeGrade(grade({ id: "c01" }))}\n`;
  const next = upsertGradeText(raw, grade({ id: "c03" }));
  assert.deepEqual(
    parseGrades(next).map((entry) => entry.id),
    ["c01", "c03"]
  );
  assert.ok(next.endsWith("\n"));
});

test("upsertGradeText collapses a repeated line for the same item", () => {
  const raw = [
    serializeGrade(grade({ note: "a" })),
    serializeGrade(grade({ note: "b" })),
  ].join("\n");
  const next = upsertGradeText(raw, grade({ note: "c" }));
  assert.equal(parseGrades(next).length, 1);
  assert.equal(parseGrades(next)[0]?.note, "c");
});

test("itemState is done only when every check and rubric id has an answer, N/A included", () => {
  const item = { checks: ["a", "b"], rubric: ["x"] };
  assert.equal(itemState(item, undefined), "empty");
  assert.equal(itemState(item, emptyDraft()), "empty");
  assert.equal(
    itemState(item, { checks: { a: true }, note: "", rubric: {} }),
    "started"
  );
  assert.equal(
    itemState(item, { checks: {}, note: "a note", rubric: {} }),
    "started"
  );
  assert.equal(
    itemState(item, {
      checks: { a: true, b: null },
      note: "",
      rubric: { x: null },
    }),
    "done"
  );
  assert.equal(
    itemState(item, { checks: { a: true, b: false }, note: "", rubric: {} }),
    "started"
  );
});

test("an item with nothing to grade is done once you answer anything, such as a note", () => {
  const item = { checks: [], rubric: [] };
  assert.equal(itemState(item, { checks: {}, note: "x", rubric: {} }), "done");
  assert.equal(itemState(item, emptyDraft()), "empty");
});

test("sampleProgress counts done and started items", () => {
  const progress = sampleProgress(sample(), {
    c01: {
      checks: { "crisis-handled": true, "no-overreach": false },
      note: "",
      rubric: { "right-help": 3, warmth: 4 },
    },
    c02: { checks: { "crisis-handled": true }, note: "", rubric: {} },
  });
  assert.deepEqual(progress, { done: 1, started: 1, total: 3 });
  assert.deepEqual(sampleProgress(sample(), {}), {
    done: 0,
    started: 0,
    total: 3,
  });
});

test("draftFromGrade copies a grade so editing the draft leaves the grade alone", () => {
  const saved = grade();
  const draft = draftFromGrade(saved);
  draft.checks["crisis-handled"] = false;
  assert.equal(saved.checks["crisis-handled"], true);
  assert.deepEqual(draftFromGrade(undefined), emptyDraft());
});

test("validateGradeInput accepts answers for the item's own ids", () => {
  const result = validateGradeInput(sample(), {
    checks: { "crisis-handled": true, "no-overreach": null },
    id: "c01",
    note: "ok",
    rubric: { warmth: 5 },
  });
  assert.deepEqual(result, {
    grade: {
      checks: { "crisis-handled": true, "no-overreach": null },
      grader: "human",
      id: "c01",
      note: "ok",
      rubric: { warmth: 5 },
      sampleId: "sample-2026-11-16",
    },
    ok: true,
  });
});

test("validateGradeInput refuses what the sample does not allow", () => {
  const refusal = (input: unknown) => {
    const result = validateGradeInput(sample(), input);
    return result.ok ? "" : result.reason;
  };
  assertHas(refusal(null), "not an object");
  assertHas(refusal({ id: "nope" }), "no item with that id");
  assertHas(refusal({ checks: { warmth: true }, id: "c01" }), "not a check");
  assertHas(
    refusal({ checks: { "crisis-handled": "yes" }, id: "c01" }),
    "pass, fail, or N/A"
  );
  assertHas(
    refusal({ id: "c01", rubric: { "crisis-handled": 3 } }),
    "not a rubric item"
  );
  assertHas(refusal({ id: "c01", rubric: { warmth: 6 } }), "1 to 5");
  assertHas(refusal({ id: "c01", rubric: { warmth: 3.5 } }), "1 to 5");
  assertHas(
    refusal({ id: "c01", note: "x".repeat(maxNoteLength + 1) }),
    "over 5000"
  );
});

test("validateGradeInput treats a missing note as empty and missing maps as nothing answered", () => {
  const result = validateGradeInput(sample(), { id: "c03" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.grade.checks, {});
    assert.deepEqual(result.grade.rubric, {});
    assert.equal(result.grade.note, "");
  }
});
