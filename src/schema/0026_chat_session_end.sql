-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- The eve sessions of deleted chats that Chat's agent has not ended yet.
-- Ending a session has eve's Workflow store delete what the session saved.
-- A delete can run before the agent answers, such as right after unlock, so
-- Sage keeps each session here and ends it once the agent answers.
CREATE TABLE chat_session_end (
  session_id TEXT PRIMARY KEY
) STRICT;
