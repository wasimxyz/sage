import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadEntryFiles } from "../evals/lib/dataset.ts";

const seedDir = fileURLToPath(new URL("../../scripts/seed", import.meta.url));

test("scripts/seed holds six dated entries in order", async () => {
  const entries = await loadEntryFiles(seedDir);

  assert.deepEqual(
    entries.map((entry) => entry.date),
    [
      "2026-08-29",
      "2026-09-09",
      "2026-09-18",
      "2026-09-24",
      "2026-09-27",
      "2026-10-06",
    ]
  );
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [1, 2, 3, 4, 5, 6]
  );
  for (const entry of entries) {
    assert.notEqual(entry.title, "", `${entry.fileName} has no title`);
    assert.ok(entry.wordCount > 0, `${entry.fileName} has no words`);
  }
});

test("a seed entry leaves its frontmatter out of the body", async () => {
  const [first] = await loadEntryFiles(seedDir);

  assert.equal(first?.title, "The last box");
  assert.ok(first?.body.startsWith("Unpacked the last box today."));
});
