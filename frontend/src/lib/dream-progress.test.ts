import assert from "node:assert/strict";
import test from "node:test";

import { formatDreamProgress } from "./dream-progress.ts";

test("formatDreamProgress is 0% before the total is known", () => {
  assert.equal(formatDreamProgress(0, 0), "0% complete");
});

test("formatDreamProgress rounds to a whole-number percent", () => {
  assert.equal(formatDreamProgress(0, 12), "0% complete");
  assert.equal(formatDreamProgress(2, 7), "29% complete");
  assert.equal(formatDreamProgress(3, 12), "25% complete");
  assert.equal(formatDreamProgress(1, 1), "100% complete");
});
