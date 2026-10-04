-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

CREATE TABLE chat_event (
  conversation_id INTEGER NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) STRICT;
