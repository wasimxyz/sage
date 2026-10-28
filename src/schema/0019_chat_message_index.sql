-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Chat search ranks one row per User or Sage message, so chunk_index is now
-- the event's seq. The old rows held 8,000-byte chunks that no search read.
DELETE FROM chat_embedding;
ALTER TABLE chat_embedding ADD COLUMN role TEXT NOT NULL DEFAULT '';

-- When a save added each event. Rows from before this migration stay NULL,
-- and search falls back to the chat's created_at and updated_at.
ALTER TABLE chat_event ADD COLUMN saved_at TEXT;

-- When the message index last caught up with the transcript. A chat is due
-- for indexing when this is missing or older than its updated_at.
CREATE TABLE chat_index_state (
  conversation_id INTEGER PRIMARY KEY REFERENCES chat_conversation(id) ON DELETE CASCADE,
  indexed_at TEXT NOT NULL
) STRICT;
