-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

CREATE TABLE journal_entry (
  id INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  word_count INTEGER NOT NULL
) STRICT;

INSERT INTO journal_entry (id, entry_date, title, body, word_count) VALUES
  (
    1,
    '2026-08-28',
    'Morning walk',
    'The fog sat low over the trail this morning. I walked without headphones and counted the crows instead. By the time I reached the creek the sun had burned through, and the water looked like glass.',
    36
  ),
  (
    2,
    '2026-08-29',
    'On building Sage',
    'Sage should keep every page on this machine. I want a journal I can open without sending a sentence to a server. The first version is a table of dates and titles, and a quiet place to read them back.',
    40
  ),
  (
    3,
    '2026-08-31',
    'Quiet evening',
    'The apartment was still after dinner. I sat with the window open and wrote until the streetlights came on. Nothing urgent. Just the day, set down.',
    26
  );
