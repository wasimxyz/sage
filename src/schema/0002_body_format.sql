-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

ALTER TABLE journal_entry ADD COLUMN body_format TEXT NOT NULL DEFAULT 'plain';
