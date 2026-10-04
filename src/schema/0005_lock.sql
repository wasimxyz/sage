-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Key-value settings owned by the Zig process. Holds the app-lock state:
-- lock.password_hash (Argon2id PHC string, salt included) and lock.touch_id
-- ("true"/"false"). Never stores a password itself.
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
