-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Chats with no user or assistant text have no semantic index to rebuild.
-- Keep their index repair from being queued again until the transcript changes.
CREATE TABLE chat_index_skip (
  conversation_id INTEGER PRIMARY KEY REFERENCES chat_conversation(id) ON DELETE CASCADE
) STRICT;
