-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- A chat id is never given out twice. chat_conversation.id is a plain
-- INTEGER PRIMARY KEY, so SQLite gives a new row MAX(id) + 1, and deleting
-- the newest chat hands its id to the next one. Saved tool output and the
-- model's own history name chats by id ("chat-12"), so an old id has to stay
-- unused. last_id is the highest id any chat has had. A new chat takes
-- last_id + 1 (see Store.insertChat).
CREATE TABLE chat_id_counter (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  last_id INTEGER NOT NULL
) STRICT;
INSERT INTO chat_id_counter (slot, last_id)
SELECT 1, COALESCE(MAX(id), 0) FROM chat_conversation;

-- Any insert moves last_id up to its id, including one that names its own.
CREATE TRIGGER chat_conversation_last_id AFTER INSERT ON chat_conversation
BEGIN
  UPDATE chat_id_counter SET last_id = NEW.id WHERE slot = 1 AND last_id < NEW.id;
END;
