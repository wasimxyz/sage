import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readEntrySummary } from "./store.ts";

const encryptedPattern = /encrypted/;

test("readEntrySummary returns plaintext summaries and rejects encrypted rows", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sage-eval-store-"));
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec(
    "CREATE TABLE entry_summary (entry_id INTEGER PRIMARY KEY, summary TEXT NOT NULL);"
  );
  db.prepare("INSERT INTO entry_summary (entry_id, summary) VALUES (?, ?)").run(
    3,
    "The user and Sam started dating."
  );
  db.prepare("INSERT INTO entry_summary (entry_id, summary) VALUES (?, ?)").run(
    4,
    "sage:v1:ciphertext"
  );
  db.close();

  const previous = process.env.SAGE_DATA_DIR;
  process.env.SAGE_DATA_DIR = dataDir;
  try {
    assert.equal(readEntrySummary(3), "The user and Sam started dating.");
    assert.throws(() => readEntrySummary(4), encryptedPattern);
    assert.equal(readEntrySummary(99), null);
  } finally {
    if (previous === undefined) {
      delete process.env.SAGE_DATA_DIR;
    } else {
      process.env.SAGE_DATA_DIR = previous;
    }
  }
});
