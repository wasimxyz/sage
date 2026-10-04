import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  countWords,
  evalDataRoot,
  journalIdFor,
  loadAllCases,
  loadCaseDir,
  loadManifest,
  parseFrontmatter,
  requireSeededEntry,
  tagsFor,
  type EvalManifest,
} from "./dataset.ts";

test("parseFrontmatter reads date, title, and body", () => {
  const parsed = parseFrontmatter(
    "---\ndate: 2026-06-15\ntitle: Told Sam\n---\n\nWe started dating.\n"
  );
  assert.equal(parsed.date, "2026-06-15");
  assert.equal(parsed.title, "Told Sam");
  assert.equal(parsed.body.trim(), "We started dating.");
});

test("countWords splits on whitespace", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one two  three "), 3);
});

test("evalDataRoot prefers SAGE_EVAL_DATA", () => {
  const previous = process.env.SAGE_EVAL_DATA;
  process.env.SAGE_EVAL_DATA = "/tmp/sage-eval-data";
  try {
    assert.equal(evalDataRoot(), "/tmp/sage-eval-data");
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_EVAL_DATA;
    } else {
      process.env.SAGE_EVAL_DATA = previous;
    }
  }
});

test("loadAllCases finds the Sam example timeline", async () => {
  const cases = await loadAllCases();
  const sam = cases.find((item) => item.id === "sam-example");
  assert.ok(sam);
  assert.equal(sam.kind, "timeline");
  assert.equal(sam.entries.length, 4);
  assert.equal(sam.entries[0]?.title, "Climbing Thursday");
  assert.equal(sam.entries[2]?.title, "Told Sam");
  assert.ok(sam.tags.includes("example"));
  assert.equal(sam.facts.length, 1);
  assert.equal(sam.events.length, 1);
  assert.equal(sam.summaries.length, 1);
  assert.equal(sam.retrieval.length, 1);
  assert.equal(sam.chat.length, 1);
  assert.equal(sam.retrieval[0]?.expectEntry, 3);
  assert.equal(
    sam.facts[0]?.stale,
    "Sam is the user's friend or climbing partner"
  );
  assert.equal(sam.chat[0]?.expectTool, false);
  assert.deepEqual(tagsFor(sam, "chat").sort(), [
    "chat",
    "example",
    "timeline",
  ]);
});

test("loadAllCases loads the round-one timelines and standalones", async () => {
  const cases = await loadAllCases();
  const ids = cases.map((item) => item.id).sort();
  assert.deepEqual(ids, [
    "breakup-reconciliation",
    "career-burnout",
    "financial-stress",
    "getting-engaged",
    "grief-after-loss",
    "imposter-syndrome",
    "losing-a-pet",
    "milestone-birthday",
    "parent-relationship",
    "portugal-trip",
    "running",
    "sam-example",
  ]);
  const breakup = cases.find((item) => item.id === "breakup-reconciliation");
  assert.ok(breakup);
  assert.equal(breakup.kind, "timeline");
  assert.equal(breakup.entries.length, 4);
  assert.equal(breakup.facts[0]?.stale, "The user and Theo broke up");
  assert.equal(breakup.retrieval[0]?.expectEntry, 4);
  const running = cases.find((item) => item.id === "running");
  assert.ok(running);
  assert.equal(running.kind, "standalone");
  assert.equal(running.entries.length, 2);
  assert.equal(running.retrieval[1]?.expectEntry, 2);
  const grief = cases.find((item) => item.id === "grief-after-loss");
  assert.ok(grief);
  assert.equal(grief.chat[1]?.expectTool, true);
});

test("journalIdFor maps 1-based entry indexes onto seeded ids", () => {
  const manifest: EvalManifest = {
    cases: { "sam-example": { journalIds: [10, 11, 12, 13] } },
  };
  assert.equal(journalIdFor(manifest, "sam-example", 3), 12);
});

test("journalIdFor rejects a missing case", () => {
  assert.throws(() => journalIdFor({ cases: {} }, "missing", 1), /missing/);
});

test("loadManifest reads journal ids from SAGE_EVAL_MANIFEST", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(
    path,
    `${JSON.stringify({ cases: { "sam-example": { journalIds: [10, 11, 12, 13] } } })}\n`
  );
  const previous = process.env.SAGE_EVAL_MANIFEST;
  process.env.SAGE_EVAL_MANIFEST = path;
  try {
    assert.equal(journalIdFor(loadManifest(), "sam-example", 3), 12);
    requireSeededEntry("sam-example", 3);
    assert.throws(() => requireSeededEntry("sam-example", 99), /entry 99/);
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_EVAL_MANIFEST;
    } else {
      process.env.SAGE_EVAL_MANIFEST = previous;
    }
  }
});

test("loadCaseDir reads expectTool and rejects a missing date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-case-"));
  writeFileSync(
    join(dir, "case.yaml"),
    [
      "id: tmp-case",
      "kind: standalone",
      "chat:",
      "  - question: What did I write?",
      "    reference: The entry body",
      "    expectTool: true",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "01-note.md"),
    "---\ndate: 2026-06-01\ntitle: Note\n---\n\nHello.\n"
  );
  const loaded = await loadCaseDir(dir);
  assert.ok(loaded);
  assert.equal(loaded.chat[0]?.expectTool, true);

  mkdirSync(join(dir, "bad"), { recursive: true });
  writeFileSync(
    join(dir, "bad", "case.yaml"),
    "id: bad-date\nkind: standalone\n"
  );
  writeFileSync(join(dir, "bad", "01.md"), "---\ntitle: No date\n---\n\nBody.\n");
  await assert.rejects(() => loadCaseDir(join(dir, "bad")), /YYYY-MM-DD/);
});
