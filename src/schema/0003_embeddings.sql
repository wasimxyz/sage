CREATE TABLE entry_embedding (
  entry_id INTEGER NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entry_id, chunk_index)
) STRICT;
