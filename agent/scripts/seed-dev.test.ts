import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadEntryFiles } from "../evals/lib/dataset.ts";
import { moveToToday } from "./seed-dates.ts";

const seedDir = fileURLToPath(new URL("../../scripts/seed", import.meta.url));
const seedDevScript = fileURLToPath(new URL("seed-dev.ts", import.meta.url));
const entryCountPattern = /25 seed entries/;
const movePattern =
  /Dates move -?\d+ days, so the newest is \d{4}-\d{2}-\d{2}\./;
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

test("scripts/seed holds 25 dated entries in order", async () => {
  const entries = await loadEntryFiles(seedDir);

  assert.deepEqual(
    entries.map((entry) => entry.date),
    [
      "2026-07-30",
      "2026-08-05",
      "2026-08-08",
      "2026-08-10",
      "2026-08-20",
      "2026-08-29",
      "2026-09-06",
      "2026-09-09",
      "2026-09-15",
      "2026-09-18",
      "2026-09-21",
      "2026-09-24",
      "2026-09-27",
      "2026-10-01",
      "2026-10-06",
      "2026-10-08",
      "2026-10-11",
      "2026-10-13",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-20",
      "2026-10-22",
      "2026-10-24",
      "2026-10-25",
    ]
  );
  assert.deepEqual(
    entries.map((entry) => entry.index),
    Array.from({ length: 25 }, (_, offset) => offset + 1)
  );
  for (const entry of entries) {
    assert.notEqual(entry.title, "", `${entry.fileName} has no title`);
    assert.ok(entry.wordCount > 0, `${entry.fileName} has no words`);
  }
});

test("a seed entry leaves its frontmatter out of the body", async () => {
  const [first] = await loadEntryFiles(seedDir);

  assert.equal(first?.title, "Last trivia night");
  assert.ok(first?.body.startsWith("Last Thursday at the Owl."));
});

test("the seed dates move from the newest file's date", async () => {
  const entries = await loadEntryFiles(seedDir);

  // 2026-10-25, the newest file's date, is a Sunday. On Wednesday
  // 2026-11-11 the newest entry lands on Sunday 2026-11-08.
  const moved = moveToToday(entries, "2026-11-11");

  assert.equal(moved.days, 14);
  assert.equal(moved.entries[0]?.date, "2026-08-13");
  assert.equal(moved.entries.at(-1)?.date, "2026-11-08");
});

test("seed-dev --check accepts the seed files without a running app", () => {
  const result = runCheck(seedDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, entryCountPattern);
  assert.match(result.stdout, movePattern);
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
