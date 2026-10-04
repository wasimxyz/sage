import assert from "node:assert/strict";
import test from "node:test";

import { memoryEnabledFrom } from "./memory-feature.ts";

test("memoryEnabledFrom accepts only an explicit boolean", () => {
  assert.equal(memoryEnabledFrom({ memory: true }), true);
  assert.equal(memoryEnabledFrom({ memory: false }), false);
  assert.equal(memoryEnabledFrom({ memory: "true" }), false);
  assert.equal(memoryEnabledFrom({}), false);
  assert.equal(memoryEnabledFrom(null), false);
  assert.equal(memoryEnabledFrom("enabled"), false);
});
