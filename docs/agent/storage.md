# Chat storage

This page explains how chats are stored in Sage’s SQLite file and how a saved conversation resumes. It also covers export and the Settings > Data actions that delete journal and chat data. The code is the chat section of `src/journal.zig` and the `chat.*` and `data.*` handlers in `src/main.zig`.

## The tables

Chat uses two tables:

- `chat_conversation`: one row per conversation, added in `0006_chat.sql`
- `chat_event`: one row per event, added in `0007_chat_events.sql`

Later migrations add to `chat_conversation`:

- `0009_chat_model_prefs.sql`: the last model and Thinking setting
- `0010_chat_context_length.sql`: the context length chosen when the conversation started
- `0011_chat_context_length_default.sql`: fills in `32768` on older rows with no context length
- `0015_chat_title_locked.sql`: `title_locked`, so Dream can write a title without overwriting a rename
- `0016_chat_index_skip.sql`: marks chats with no User or Sage text, so Dream skips them until the transcript changes

Each conversation row has:

- `id`: the conversation id
- `title`: encrypted when encryption is on. The frontend sets it from the first message, Dream may replace it, and `chat.rename` changes it.
- `title_locked`: `1` after a rename, otherwise `0`. Dream writes a title only when this is `0`.
- `eve_session_id`: the eve session to resume, readable on purpose
- `stream_index`: how far the event stream has been read
- `model`: the last chat model used. Older rows have it empty until a later save writes it.
- `thinking`: the last Thinking switch, `1` for on and `0` for off. It is missing on conversations from before this column.
- `context_length`: the context length chosen before the first message. A later save fills in a missing value once and then leaves it.
- `events`: unused. It held the transcript before `0007`, and Sage leaves it empty, as [Older conversations](#older-conversations) explains.
- `created_at` and `updated_at`: readable timestamps. The sidebar sorts by `updated_at`, which changes only when the transcript changes.

Reopening a chat, renaming it, a Dream title, and saving only the session or the model all leave `updated_at` alone.

Each event row has:

- `conversation_id` and `seq`: the conversation and the event’s position in the transcript
- `event`: the eve stream event, encrypted per row

One event can be at most 128 KiB. Reads fetch rows in 256 KiB pages, so a save with a larger event fails instead of storing a row that reads cannot return.

## The save protocol

Bridge messages have a size limit, so new events travel in 32 KiB chunks:

1. The frontend compares the events it wants to save with the last successful save, and keeps the length of the shared start as `baseSeq`.
2. It sends only the events after that point, as a JSON array, in chunks that never split a UTF-8 character.
3. Each `chat.save` call carries one chunk, its byte offset, `baseSeq`, a `done` flag, the model, the Thinking setting, and the context length.
4. The core adds each chunk to a buffer in memory and checks that the offsets arrive in order.
5. When `done` arrives, the core deletes stored rows with `seq >= baseSeq` and inserts the new events.

Most turns fit in one call. A later turn can insert stream events before a human-in-the-loop answer saved at the end of the last turn, and deleting from `baseSeq` keeps that rewrite correct.

The other fields in the payload follow these rules:

- The title is used only when the call creates the conversation, so a rename or a Dream title is never overwritten.
- The context length is stored when the row is created. A later save writes it only if the stored value is missing.
- A save for a conversation that no longer exists returns `NotFound`.

## Opening a conversation

`chat.get` reads by event position, not by bytes:

1. The frontend calls `chat.get` with `offset` set to the next `seq`.
2. The core returns a JSON array of events, plus `nextSeq` and `done`.
3. The frontend joins pages until `done` is true.

Each row is small, so the core does not slice columns or keep a decrypted copy of the transcript.

## Resuming a conversation

Reopening a conversation restores the transcript, the eve session, and the picker:

1. The frontend reads the events with `chat.get`.
2. Those events become `initialEvents` on the `useEveAgent` hook, which shows the transcript as it was.
3. The session id and stream index become `initialSession`, and the hook resumes that session for the next turn.
4. The model, Thinking, and context length columns set the picker.

[The Chat frontend](frontend.md#the-model-picker) covers what the picker uses when an older row is missing a column.

## Searching transcripts

`chat.search` looks through conversation titles and the user and assistant text in `message.received` and `message.completed` events. It skips tool payloads, streaming deltas, and empty messages. Hits are newest first, with at most 3 message hits per conversation and 25 overall.

Each message hit includes the conversation id and the event `seq`, so the Chat screen can open the transcript and scroll to the matching message.

## What is encrypted

When encryption is on, titles and events are encrypted:

- Titles use the label `chat_conversation:title`.
- Each event uses `chat_event:<conversation_id>:<seq>`, so an encrypted row cannot be moved to another conversation or position.

Session ids, timestamps, `seq`, the model name, the Thinking setting, and the context length stay readable. That lets the sidebar list and resume work without decrypting every row. [Encryption at rest](../security/encryption.md) covers the passes that encrypt and decrypt these rows.

## Exporting conversations

File > Export and Settings > Data > Export data write a `sage-export-YYYYMMDD` folder inside a folder you pick, with two subfolders:

- `journal/`: one Markdown file per entry
- `conversations/`: two files per conversation, named `<title>-<date>-<id>`

The `.md` file is a transcript with `**User:**` and `**Assistant:**` turns, without tool calls or attachments. The `.json` file is the full record: the conversation fields, then every saved event in order. Both files are plaintext, even when encryption is on.

The core reads 32 events at a time and writes both files as it goes, so a long chat never sits in memory whole. Exporting again on the same day rewrites the same folder and leaves other files in it alone. Conversations from before `0007` export without events.

## Older conversations

`0007` only created `chat_event`, and Sage does not read or convert the old `events` column. A conversation saved before `0007` opens empty in Chat. Search, Dream, the encryption passes, and export all skip it.

## eve’s session files

eve keeps its own session files outside SQLite:

- **`make dev`**: under `agent/.eve/`, always plaintext
- **Packaged app**: under `.eve/.workflow-data` in `~/Library/Application Support/com.wasimxyz.sage/eve/`, encrypted when journal encryption is on

[Encryption at rest](../security/encryption.md#chat-workflow-files) covers how those files are encrypted. The SQLite rows are the record Sage encrypts and shows in the Chat screen.

Deleting a chat also deletes its session files, found by its `eve_session_id`:

- The id is a workflow run id (`wrun_…`). Sage ignores an id that does not have that shape, so a stored value cannot reach outside the workflow folder.
- If the agent is running, Sage first asks it to cancel the current turn. That request can finish after the files are gone, so the agent may still write.
- Deleting still succeeds if the files are already gone or the agent is down.

On launch, Sage deletes run folders in `.eve/.workflow-data` that no saved chat points to and that are more than an hour old. That catches files left by a late cancel or by [session recovery](frontend.md#recovering-a-session-that-ended). `src/eve_sidecar.zig` lists every kind of file it removes.

## Deleting data

Settings > Data counts journal entries, conversations, index rows, and visible memories. Each action stays off until the counts load, and a count of zero turns that action off. Every action asks you to type `delete` in lowercase.

| Action | Command | Deletes | Keeps |
| --- | --- | --- | --- |
| Journal entries | `data.deleteEntries` | Every entry, its embeddings and summary, and the memories Dream wrote from it, including pinned and hidden rows | Memories you added, and all conversations |
| Conversations | `data.deleteConversations` | Every conversation, its transcript, embeddings, and summary, and the memories Dream wrote from it | Memories you added, and journal entries |
| Embeddings | `data.deleteEmbeddings` | `entry_embedding`, `entry_summary`, `chat_embedding`, and `chat_summary` | Entries, conversations, memories, and memory embeddings |
| Memories | `data.deleteMemories` | Every profile sentence, fact, and event, including rows you added and hidden rows, plus Dream times | Entries and conversations |
| Delete all data | `data.deleteAll` | Every entry, conversation, embedding, summary, and memory | The lock password, Touch ID, encryption settings, and Chat instructions |

After the Embeddings wipe, Sage embeds entries again, and the next Dream rebuilds summaries and chat indexes. Dream times stay, so Dream does not extract memories again. If Ollama is down, Sage embeds the entries once Ollama is back.

The Memories count includes visible rows only. If only hidden rows remain, the count is zero and the action stays off.

All five actions refuse while Sage is locked or while a rewrite or file rebuild is running. Each one cancels a running Dream and marks older Dream work as stale, so it cannot write deleted rows back. Each one then rebuilds the SQLite file, and a failed rebuild still reports success because the rows are already gone.

The Conversations and Delete all data actions also remove eve session files and restart Chat. The other actions refresh the open screens in place. Only Delete all data clears local storage, including the saved Chat picker choices, and reloads the window.
