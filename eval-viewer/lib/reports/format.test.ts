import assert from "node:assert/strict";
import test from "node:test";

import { passRate, passRateTone } from "./format.ts";

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
