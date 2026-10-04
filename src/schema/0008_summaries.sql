-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

CREATE TABLE entry_summary (
  entry_id INTEGER PRIMARY KEY REFERENCES journal_entry(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  embed_model TEXT NOT NULL,
  summarized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
