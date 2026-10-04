-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Conversations created before context_length existed ran at the agent's
-- 32768-token window. Write that snapshot so the picker stays frozen.
UPDATE chat_conversation SET context_length = 32768 WHERE context_length IS NULL;
