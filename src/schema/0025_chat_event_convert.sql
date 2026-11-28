-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- A chat's converted events wait here until every one is written. One
-- transaction then swaps them for the chat's saved events, so a conversion
-- that stops partway leaves the chat as it was. The table is empty between
-- conversions. Rows are encrypted for their place in chat_event.
CREATE TABLE chat_event_convert (
  conversation_id INTEGER NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  saved_at TEXT,
  PRIMARY KEY (conversation_id, seq)
) STRICT;
