// Review repro: the head-to-head label lines for a conversation (and the
// reference line for a fact question) are written in head-to-head.ts, and the
// rubric hash never reads them, so editing them keeps the same hash.
import assert from "node:assert/strict";
import test from "node:test";

import { rubricMaterial } from "../agent/evals/lib/grader.ts";
import { detailsOf } from "../agent/evals/lib/head-to-head.ts";
import { fixturePerson } from "../agent/evals/lib/sweep-fixtures.ts";

test("every label line the judge sees in a head-to-head conversation is in the rubric hash material", () => {
  const owner = fixturePerson("sam");
  const lines = detailsOf(
    {
      ended: "done",
      itemId: "sam/conversation/wedding-costs",
      journal: "own",
      kind: "conversation",
      person: "sam",
      repeat: 1,
      setupId: "a1a1a1a1a1",
      simulatedUserFlags: [],
      turns: [],
    },
    owner
  );
  const material = JSON.stringify(rubricMaterial());
  // The fixed wording, without the per-item values after the colon.
  const fixed = lines
    .map((line) => line.split(":")[0] ?? line)
    .filter((prefix) => !material.includes(prefix.replace(/^- /u, "")));
  assert.deepEqual(fixed, []);
});
