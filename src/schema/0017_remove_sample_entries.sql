-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Migration 1 put three sample entries in every new journal. A new journal now
-- starts empty, so first-launch setup can tell a new person from an existing one.
--
-- A sample entry that nobody has edited still has the epoch updated_at that
-- migration 4 gave it. Saving, importing, and editing stamp the real time, and
-- the encryption rewrite leaves updated_at alone, so this finds untouched samples
-- in plaintext and encrypted journals alike. An entry the person edited stays.
--
-- The rows that hang off each sample go too: its embeddings, summary, memories,
-- and Dream state, the same rows journal.delete removes. Without that, the next
-- entry to take id 1, 2, or 3 would pick up a deleted sample's rows.

DELETE FROM entry_summary WHERE entry_id IN (SELECT id FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z');
DELETE FROM entry_embedding WHERE entry_id IN (SELECT id FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z');
DELETE FROM semantic_fact WHERE source_type = 'entry' AND source_id IN (SELECT id FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z');
DELETE FROM episodic_event WHERE source_type = 'entry' AND source_id IN (SELECT id FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z');
DELETE FROM dream_state WHERE source_type = 'entry' AND source_id IN (SELECT id FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z');
DELETE FROM journal_entry WHERE id IN (1, 2, 3) AND updated_at = '1970-01-01T00:00:00.000Z';
