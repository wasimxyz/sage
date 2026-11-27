// A sample the agent writes is read by the viewer's grading
// form, and the line the form writes is read back by the agreement eval.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGradeLine,
  serializeGrade,
  validateGradeInput,
  parseCalibrationSample as viewerParseSample,
} from "../../../eval-viewer/lib/reports/calibration.ts";
import {
  parseCalibrationSample as agentParseSample,
  CALIBRATED_CHECK_IDS,
  CALIBRATED_RUBRIC_IDS,
  gradedItems,
  gradeKey,
  parseHumanGrade,
} from "../../evals/lib/calibration.ts";

test("agent sample -> viewer form -> grades.jsonl line -> agent agreement input", () => {
  const sample = agentParseSample({
    items: [
      {
        checks: [CALIBRATED_CHECK_IDS[0], CALIBRATED_CHECK_IDS[1]],
        context: {
          factSheet: "Cast: Jordan (fiancé)",
          priorTurns: [
            { role: "user", text: "hi" },
            { role: "assistant", text: "hey" },
          ],
          toolCalls: [
            {
              input: { query: "rent" },
              name: "search_journal",
              output: { results: [] },
              status: "completed",
            },
          ],
        },
        expect: "venting",
        id: "a1a1a1a1a1:sam/opener/rent-panic:r1:t1",
        itemId: "sam/opener/rent-panic",
        journal: "own",
        kind: "opener",
        message: "Rent is due.",
        person: "sam",
        repeat: 1,
        reply: "That sounds hard.",
        rubric: [CALIBRATED_RUBRIC_IDS[0]],
        setupId: "a1a1a1a1a1",
        turn: 1,
      },
    ],
    sampleId: "2026-11-12T010000Z-screen",
    seed: 1,
    sweepId: "2026-11-12T010000Z-screen",
  });
  const viewer = viewerParseSample(JSON.stringify(sample));
  assert.equal(viewer.kind, "ok");
  if (viewer.kind !== "ok") {
    return;
  }
  const [item] = viewer.value.items;
  assert.ok(item);
  const [firstCheck, secondCheck] = item.checks;
  const [rubricId] = item.rubric;
  assert.ok(firstCheck && secondCheck && rubricId);
  const checked = validateGradeInput(viewer.value, {
    checks: { [firstCheck]: false, [secondCheck]: null },
    id: item.id,
    note: "",
    rubric: { [rubricId]: 4 },
  });
  assert.ok(checked.ok);
  if (!checked.ok) {
    return;
  }
  const line = serializeGrade({
    ...checked.grade,
    gradedAt: "2026-11-16T10:00:00.000Z",
  });
  assert.ok(parseGradeLine(line));
  const grade = parseHumanGrade(JSON.parse(line));
  const graded = gradedItems(
    [sample],
    new Map([[gradeKey(grade.sampleId, grade.id), grade]])
  );
  assert.equal(graded.length, 1);
});
