-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Dream writes a generated title unless the user renamed the chat.
-- chat.rename sets this to 1. Dream title writes leave updated_at alone.
ALTER TABLE chat_conversation ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
