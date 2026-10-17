-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- The move to eve 0.80 ends every saved Chat session. Its local workflow store
-- deletes run data that older versions wrote, and eve no longer runs a session
-- that an older eve built. Resuming a saved session id would wait on a stream
-- that is gone, so forget the ids. A reopened chat then starts a fresh session
-- and sends the saved transcript as context, the same as recovering a session
-- that ended. The transcript and updated_at stay as they are.

UPDATE chat_conversation SET eve_session_id = NULL, stream_index = 0 WHERE eve_session_id IS NOT NULL;
