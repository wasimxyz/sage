import assert from "node:assert/strict";
import test from "node:test";

import { waitSecondsFromMs } from "./lock-wait.ts";

test("waitSecondsFromMs rounds a leftover up to whole seconds", () => {
  assert.equal(waitSecondsFromMs(5000), 5);
  assert.equal(waitSecondsFromMs(4999), 5);
  assert.equal(waitSecondsFromMs(4001), 5);
  assert.equal(waitSecondsFromMs(1200), 2);
  assert.equal(waitSecondsFromMs(1), 1);
});

test("waitSecondsFromMs reads no wait as zero", () => {
  assert.equal(waitSecondsFromMs(0), 0);
  assert.equal(waitSecondsFromMs(-1), 0);
  assert.equal(waitSecondsFromMs(Number.NaN), 0);
});
