-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

CREATE TABLE chat_conversation (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  eve_session_id TEXT,
  stream_index INTEGER NOT NULL DEFAULT 0,
  events TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
