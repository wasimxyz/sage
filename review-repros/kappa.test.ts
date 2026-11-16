// Review repro: the calibration agreement math on known examples.
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAgreement,
  quadraticWeightedKappa,
  rubricAgreement,
} from "../agent/evals/lib/calibration.ts";

/** Textbook QWK from a confusion matrix, written independently. */
function referenceKappa(pairs: [number, number][]): number | null {
  const k = 5;
  const o = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const [a, b] of pairs) {
    (o[a - 1] as number[])[b - 1] += 1;
  }
  const n = pairs.length;
  const rows = o.map((row) => row.reduce((s, v) => s + v, 0));
  const cols = o[0]!.map((_, j) => o.reduce((s, row) => s + (row[j] ?? 0), 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const w = (i - j) ** 2 / (k - 1) ** 2;
      num += w * (o[i]?.[j] ?? 0);
      den += (w * (rows[i] ?? 0) * (cols[j] ?? 0)) / n;
    }
  }
  return den === 0 ? null : 1 - num / den;
}

test("kappa matches a textbook implementation on varied pairs", () => {
  const cases: [number, number][][] = [
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]],
    [[1, 5], [5, 1]],
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 4]],
    [[3, 4], [4, 4], [2, 3], [5, 5], [1, 2], [4, 3], [3, 3]],
  ];
  for (const pairs of cases) {
    const got = quadraticWeightedKappa(pairs);
    const want = referenceKappa(pairs);
    assert.ok(got !== null && want !== null);
    assert.ok(Math.abs(got - want) < 1e-12, `${got} vs ${want}`);
  }
  assert.equal(quadraticWeightedKappa([[1, 5], [5, 1]]), -1);
});

test("docs say kappa is n/a when either rater gave one score every time", () => {
  // docs/agent/evals.md: "It is `n/a` when either of you gave one score every time."
  // You always gave 4; the judge varied.
  const oneSided = quadraticWeightedKappa([[4, 3], [4, 4], [4, 5]]);
  // Both constant but different.
  const bothConstantApart = quadraticWeightedKappa([[4, 2], [4, 2]]);
  assert.equal(oneSided, null, `got ${oneSided}`);
  assert.equal(bothConstantApart, null, `got ${bothConstantApart}`);
});

test("hits, misses, false alarms, and skipped nulls", () => {
  const comparisons = [
    { checks: { "crisis-handled": { human: false, judge: false } }, id: "1", rubric: {}, sampleId: "s" },
    { checks: { "crisis-handled": { human: false, judge: true } }, id: "2", rubric: {}, sampleId: "s" },
    { checks: { "crisis-handled": { human: true, judge: false } }, id: "3", rubric: {}, sampleId: "s" },
    { checks: { "crisis-handled": { human: true, judge: true } }, id: "4", rubric: {}, sampleId: "s" },
    { checks: { "crisis-handled": { human: null, judge: false } }, id: "5", rubric: {}, sampleId: "s" },
    { checks: { "crisis-handled": { human: true, judge: null } }, id: "6", rubric: {}, sampleId: "s" },
  ];
  const agreement = checkAgreement("crisis-handled", comparisons);
  assert.deepEqual(
    { falseAlarms: agreement.falseAlarms, hits: agreement.hits, misses: agreement.misses, n: agreement.n, passes: agreement.passes },
    { falseAlarms: 1, hits: 1, misses: 1, n: 4, passes: 1 }
  );
  const rubric = rubricAgreement("warmth", [
    { checks: {}, id: "1", rubric: { warmth: { human: 3, judge: 3 } }, sampleId: "s" },
    { checks: {}, id: "2", rubric: { warmth: { human: 3, judge: 4 } }, sampleId: "s" },
    { checks: {}, id: "3", rubric: { warmth: { human: 1, judge: 4 } }, sampleId: "s" },
    { checks: {}, id: "4", rubric: { warmth: { human: null, judge: 4 } }, sampleId: "s" },
  ]);
  assert.equal(rubric.n, 3);
  assert.equal(rubric.exact, 1 / 3);
  assert.equal(rubric.within1, 2 / 3);
  assert.equal(rubric.meanDiff, (0 + 1 + 3) / 3);
});
