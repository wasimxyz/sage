import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHours,
  formatMegabytes,
  formatMs,
  formatRate,
  formatScore,
  formatSpread,
  formatUsd,
  passRate,
  passRateTone,
} from "./format.ts";

test("passRate rounds to a whole percent", () => {
  assert.equal(passRate(200, 237), 84);
  assert.equal(passRate(0, 0), 0);
  assert.equal(passRate(10, 10), 100);
});

test("passRateTone uses 90 and 70 as the cutoffs", () => {
  assert.equal(passRateTone(100), "pass");
  assert.equal(passRateTone(90), "pass");
  assert.equal(passRateTone(89), "warn");
  assert.equal(passRateTone(70), "warn");
  assert.equal(passRateTone(69), "fail");
  assert.equal(passRateTone(0), "fail");
});

test("sweep numbers show a dash when there is no value", () => {
  assert.equal(formatRate(0.04), "4.0%");
  assert.equal(formatRate(1.25), "125.0%");
  assert.equal(formatScore(0.783), "0.78");
  assert.equal(formatScore(null), "—");
  assert.equal(formatSpread(0.02), "±0.02");
  assert.equal(formatSpread(null), "—");
  assert.equal(formatMs(5200), "5.2s");
  assert.equal(formatMs(24_000), "24.0s");
  assert.equal(formatMs(null), "—");
  assert.equal(formatUsd(11.4), "$11.40");
  assert.equal(formatUsd(null), "—");
  assert.equal(formatHours(7.1), "7.1 h");
  assert.equal(formatMegabytes(9200.4), "9200 MB");
  assert.equal(formatMegabytes(null), "—");
});
