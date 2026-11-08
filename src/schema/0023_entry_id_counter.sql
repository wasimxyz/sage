-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- An entry id is never given out twice, the same way migration 21 does it for
-- chats. journal_entry.id is a plain INTEGER PRIMARY KEY, so SQLite gives a new
-- row MAX(id) + 1, and deleting the newest entry hands its id to the next one.
-- Saved tool output, the model's own history, and memories name entries by id
-- ("entry-12"), so an old id has to stay unused. last_id is the highest id any
-- entry has had. A new entry takes last_id + 1 (see Store.insertEntry).
CREATE TABLE entry_id_counter (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  last_id INTEGER NOT NULL
) STRICT;
INSERT INTO entry_id_counter (slot, last_id)
SELECT 1, COALESCE(MAX(id), 0) FROM journal_entry;

-- Any insert moves last_id up to its id, including one that names its own.
CREATE TRIGGER journal_entry_last_id AFTER INSERT ON journal_entry
BEGIN
  UPDATE entry_id_counter SET last_id = NEW.id WHERE slot = 1 AND last_id < NEW.id;
END;
