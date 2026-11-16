// Review repro: the viewer's check tiers agree with the agent's CHECK_TIERS.
import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_TIERS } from "../agent/evals/lib/schema.ts";
import { checkTier } from "../eval-viewer/lib/reports/check-info.ts";

test("every agent check id has the same tier in the viewer", () => {
  const mismatches = Object.entries(CHECK_TIERS)
    .filter(([id, tier]) => checkTier(id) !== tier)
    .map(([id, tier]) => `${id}: agent ${tier}, viewer ${checkTier(id)}`);
  assert.deepEqual(mismatches, []);
});
