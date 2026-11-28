-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- The move to eve 1.0 ends every saved Chat session. eve no longer runs a
-- session that an older eve built, so forget the ids, as 0018 did for eve
-- 0.80. A reopened chat starts a fresh session and sends the saved transcript
-- as context. The transcript and updated_at stay as they are.
UPDATE chat_conversation SET eve_session_id = NULL, stream_index = 0 WHERE eve_session_id IS NOT NULL;

-- eve 1.0 also changed its event format, from stream version 26 to 27. A
-- chat's events keep the format they were saved in until Chat converts them
-- once: 26 for events an earlier eve wrote, 27 for eve 1.0 events. New chats
-- start at 27.
ALTER TABLE chat_conversation ADD COLUMN event_format INTEGER NOT NULL DEFAULT 27;
UPDATE chat_conversation SET event_format = 26 WHERE EXISTS (
  SELECT 1 FROM chat_event WHERE chat_event.conversation_id = chat_conversation.id
);
