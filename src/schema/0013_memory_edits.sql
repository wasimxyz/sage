-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- User edits pin a row so a later Dream of the same source does not
-- delete it. Hidden rows stay in the file so Dream will not write the
-- same extraction again. origin_text holds the Dream wording the pin
-- stands in for. ALTER TABLE cannot use a non-constant default, so
-- existing rows get an epoch timestamp, then copy created_at.

ALTER TABLE semantic_fact ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE semantic_fact ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE semantic_fact ADD COLUMN origin_text TEXT NOT NULL DEFAULT '';
ALTER TABLE semantic_fact ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

ALTER TABLE episodic_event ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodic_event ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodic_event ADD COLUMN origin_text TEXT NOT NULL DEFAULT '';
ALTER TABLE episodic_event ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE semantic_fact SET updated_at = created_at;
UPDATE episodic_event SET updated_at = created_at;
