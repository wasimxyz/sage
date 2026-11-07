-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- A search by time reads each chat event's saved_at. Events saved before
-- migration 19 have none, so the chat's created_at and unstamped_until stand
-- in for when they were said. unstamped_until is the last moment one of them
-- could have been saved: the chat's updated_at as it is now, before a later
-- save moves it, or its earliest saved_at when a save has already moved it.
-- It stays NULL for a chat with no such events.
ALTER TABLE chat_conversation ADD COLUMN unstamped_until TEXT;
UPDATE chat_conversation SET unstamped_until = COALESCE(
  (SELECT MIN(chat_event.saved_at) FROM chat_event
   WHERE chat_event.conversation_id = chat_conversation.id
     AND chat_event.saved_at IS NOT NULL),
  chat_conversation.updated_at
) WHERE EXISTS (
  SELECT 1 FROM chat_event
  WHERE chat_event.conversation_id = chat_conversation.id
    AND chat_event.saved_at IS NULL
);

-- Listing chats by time looks up each chat's events by saved_at. Without an
-- index that reads every event row, and saved_at sits after the large event
-- column.
CREATE INDEX chat_event_saved_at ON chat_event(conversation_id, saved_at);
