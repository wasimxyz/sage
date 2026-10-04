-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

CREATE TABLE chat_embedding (
  conversation_id INTEGER NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (conversation_id, chunk_index)
) STRICT;

CREATE TABLE chat_summary (
  conversation_id INTEGER PRIMARY KEY REFERENCES chat_conversation(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  embed_model TEXT NOT NULL,
  summarized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE semantic_fact (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding BLOB,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE episodic_event (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  embedding BLOB NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE dream_state (
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  dreamed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (source_type, source_id)
) STRICT;
