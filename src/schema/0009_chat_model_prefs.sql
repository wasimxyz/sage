-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

ALTER TABLE chat_conversation ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_conversation ADD COLUMN thinking INTEGER;
