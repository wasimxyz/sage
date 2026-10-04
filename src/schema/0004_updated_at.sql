-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- ALTER TABLE cannot use a non-constant default, so existing rows get an
-- epoch timestamp. Rows that already have embeddings are then aligned to
-- their newest embedded_at so startup does not re-embed them.
ALTER TABLE journal_entry ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE journal_entry
SET updated_at = (
  SELECT MAX(embedded_at)
  FROM entry_embedding
  WHERE entry_id = journal_entry.id
)
WHERE EXISTS (
  SELECT 1 FROM entry_embedding WHERE entry_id = journal_entry.id
);
