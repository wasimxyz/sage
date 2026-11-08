-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Migration 19 stored who sent each indexed message in the clear. The chat
-- event that holds the message is encrypted, so that column was the one place
-- the file said whether a message came from the user or from Sage. Search now
-- reads the sender from the events of the hits it keeps.
ALTER TABLE chat_embedding DROP COLUMN role;
