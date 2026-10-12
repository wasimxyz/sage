import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadEntryFiles } from "../evals/lib/dataset.ts";

const seedDir = fileURLToPath(new URL("../../scripts/seed", import.meta.url));
const seedDevScript = fileURLToPath(new URL("seed-dev.ts", import.meta.url));
const sixEntriesPattern = /6 seed entries/;
const badFilePattern = /02-bad\.md needs a title/;

// The script reads these two. --check must need only the first.
function runCheck(dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, SAGE_SEED_DIR: dir };
  env.SAGE_AUTOMATION_CWD = undefined;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", seedDevScript, "--check"],
    { encoding: "utf8", env }
  );
}

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

test("seed-dev --check accepts the seed files without a running app", () => {
  const result = runCheck(seedDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, sixEntriesPattern);
});

test("seed-dev --check names the file it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-seed-check-"));
  try {
    writeFileSync(
      join(dir, "01-ok.md"),
      "---\ntitle: Ok\ndate: 2026-10-01\n---\n\nA day.\n"
    );
    writeFileSync(
      join(dir, "02-bad.md"),
      "---\ndate: 2026-10-02\n---\n\nNo title.\n"
    );

    const result = runCheck(dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, badFilePattern);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
