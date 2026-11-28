# Chat storage

This page explains how chats are stored in Sage’s SQLite file, how a saved conversation resumes, and how Chat’s chat search indexes messages. It also covers export and the Settings > Data actions that delete journal and chat data. The code is the chat section of `src/journal.zig` and the `chat.*` and `data.*` handlers in `src/main.zig`.

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
- `0019_chat_message_index.sql`: adds `saved_at` to `chat_event`, a `role` column to `chat_embedding`, and the `chat_index_state` table, for [the message index](#the-message-index)
- `0020_chat_time_bounds.sql`: adds `unstamped_until`, and an index on `chat_event` by `conversation_id` and `saved_at`, so a search or listing by time can place events from before `0019`
- `0021_chat_id_counter.sql`: adds `chat_id_counter`, so a chat id is never used twice
- `0022_chat_index_no_role.sql`: drops `role` from `chat_embedding`, so the index does not say who sent a message
- `0024_eve_v27_events.sql`: forgets every eve session id, as `0018` did, and adds `event_format`, as [Chats saved before eve 1.0](#chats-saved-before-eve-10) explains
- `0025_chat_event_convert.sql`: adds `chat_event_convert`, where a conversion writes a chat’s events before it swaps them in
- `0026_chat_session_end.sql`: adds `chat_session_end`, the eve sessions of deleted chats that the agent has not ended yet

Each conversation row has:

- `id`: the conversation id. Saved tool output and the model’s own history name chats by it (`chat-12`), so Sage never gives an id to a second chat. `chat_id_counter` holds the highest id given out, and a new chat takes the next one. Deleting a chat, or all of them, does not lower it.
- `title`: encrypted when encryption is on. The frontend sets it from the first message, Dream may replace it, and `chat.rename` changes it.
- `title_locked`: `1` after a rename, otherwise `0`. Dream writes a title only when this is `0`.
- `eve_session_id`: the eve session to resume, readable on purpose
- `stream_index`: how far the event stream has been read
- `model`: the last chat model used. Older rows have it empty until a later save writes it.
- `thinking`: the last Thinking switch, `1` for on and `0` for off. It is missing on conversations from before this column.
- `context_length`: the context length chosen before the first message. A later save fills in a missing value once and then leaves it.
- `events`: unused. It held the transcript before `0007`, and Sage leaves it empty, as [Older conversations](#older-conversations) explains.
- `created_at` and `updated_at`: readable timestamps. The sidebar sorts by `updated_at`, which changes only when the transcript changes.
- `event_format`: the eve stream version of the chat’s events. `26` marks a chat saved before eve 1.0 that Chat has not converted yet, and `27` every other chat.
- `unstamped_until`: the last moment an event with no `saved_at` could have been saved. `0020` sets it to the chat’s `updated_at` when the chat has such events, or to the earliest `saved_at` if a later save has already moved `updated_at`. It stays empty for a chat with none.

Reopening a chat, renaming it, a Dream title, and saving only the session or the model all leave `updated_at` alone.

Each event row has:

- `conversation_id` and `seq`: the conversation and the event’s position in the transcript
- `event`: the eve stream event, encrypted per row. Since eve 1.0 it is a stream version 27 event, with its place in eve’s stream in `meta.position`.
- `saved_at`: when a save added the event. Events from before `0019` have none. A search by time places them between the chat’s `created_at` and `unstamped_until`, so a chat that started before `0019` and went on later does not match the months between.

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

A save with `convert: true` replaces every event of a chat with the same transcript in eve 1.0’s format. It needs `baseSeq` 0 and a chat whose `event_format` is 26, takes no title, and changes no other column, as [Chats saved before eve 1.0](#chats-saved-before-eve-10) explains.

The core keeps one chunked save at a time, so `bridge.ts` sends each save after the one before it ends. A reply’s save and a conversion never mix chunks.

## Opening a conversation

`chat.get` reads by event position, not by bytes:

1. The frontend calls `chat.get` with `offset` set to the next `seq`.
2. The core returns a JSON array of events, plus `nextSeq` and `done`.
3. The frontend joins pages until `done` is true.

Each row is small, so the core does not slice columns or keep a decrypted copy of the transcript.

## Resuming a conversation

Reopening a conversation restores the transcript, the eve session, and the picker:

1. The frontend reads the events with `chat.get`, and converts a chat saved before eve 1.0 first.
2. The events of the chat’s last eve session become `initialEvents` on the `useEveAgent` hook, which shows them as they were. eve takes the events of one session only, so earlier sessions show as history above them.
3. The session id and stream index become `initialSession`, and the hook resumes that session for the next turn.
4. The model, Thinking, and context length columns set the picker.

[The Chat frontend](frontend.md#the-model-picker) covers what the picker uses when an older row is missing a column.

## Searching transcripts

`chat.search` looks through conversation titles and the User and Sage text of each chat. What you sent is the first text part of a `delivery.consumed` event, and Sage’s text is each `content.completed` event with `kind` `text`, for both the reply and the text before a tool call. In a chat not converted yet, the same text is in `message.received` and `message.completed`. Search skips reasoning, tool payloads, streaming deltas, and empty messages. Hits are newest first, with at most 3 message hits per conversation and 25 overall.

Each message hit includes the conversation id and the event `seq`, so the Chat screen can open the transcript and scroll to the matching message.

## The message index

Chat’s `search_chats` tool ranks User and Sage messages by meaning, in every build. Each message with text has one row in `chat_embedding`:

- `chunk_index`: the message’s event `seq`
- `chunk_text`: the message text, cut at 8,000 bytes and encrypted with the label `chat_embedding:<conversation_id>:<seq>`
- `embedding` and `model`: the vector and the embedding model that made it

The row does not say whether the user or Sage sent the message. Search reads that from the message’s own event, and only for the hits it keeps.

`chat_index_state` records when each chat’s index last caught up. A chat needs indexing when it has events, isn’t marked in `chat_index_skip`, and its `indexed_at` is missing or older than its `updated_at`.

Messages get their rows at three points:

1. **After a reply**: when a turn finishes and its events save, the Chat screen calls `embeddings.generate` with the chat’s id. Sage embeds the messages that have no row, up to 32 at a time, and answers `more` until none are left.
2. **When Sage loads your entries**: the same pass that embeds stale entries also indexes chats that need it, such as one saved while Ollama was down. Entries go first, and the pass does not wait for the chats. It lists at most 4,096 chats, and the rest wait for the next pass or Dream. If Ollama is down, it tries again every 15 seconds. A delete in Settings > Data can cut off a chat’s batch, and that chat is tried again right away, up to 3 times. A chat that fails for another reason, such as one deleted during the pass, is skipped without a retry.
3. **During Dream**: Dream indexes up to 1,024 messages of each chat that needs it, in every build.

Rows are only removed from the end of a chat or all at once, so every message after the newest row is new. When a save replaces events from `baseSeq` on, it deletes their rows in the same write. A chat saved while its messages were being embedded drops that batch, and the next pass reads the new transcript.

`0019` deleted the 8,000-byte chunks earlier builds stored, which no search read. Each chat is indexed again the next time one of the three points reaches it.

`get_chat` counts the messages on each side of what it shows. Only the encrypted event says who wrote it. So Sage takes the messages the index has caught up with from `chunk_index`, which is readable. It decrypts only the events after the newest row, then reads only the events it shows, 5 at most.

## What is encrypted

When encryption is on, titles and events are encrypted:

- Titles use the label `chat_conversation:title`.
- Each event uses `chat_event:<conversation_id>:<seq>`, so an encrypted row cannot be moved to another conversation or position.

Session ids, timestamps, `seq`, the model name, the Thinking setting, and the context length stay readable. That lets the chat list and resume work without decrypting every row. Each event’s `saved_at` stays readable too, and so does a chat’s `unstamped_until`, so a chat search by time can filter rows before it decrypts any. [Encryption at rest](../security/encryption.md) covers the passes that encrypt and decrypt these rows.

## Exporting conversations

File > Export and Settings > Data > Export data write a `sage-export-YYYYMMDD` folder inside a folder you pick, with two subfolders:

- `journal/`: one Markdown file per entry
- `conversations/`: two files per conversation, named `<title>-<date>-<id>`

The `.md` file is a transcript with `**User:**` and `**Assistant:**` turns, without tool calls or attachments. The `.json` file is the full record: the conversation fields, then every saved event in order. Both files are plaintext, even when encryption is on.

The core reads 32 events at a time and writes both files as it goes, so a long chat never sits in memory whole. Exporting again on the same day rewrites the same folder and leaves other files in it alone. Conversations from before `0007` export without events.

## Chats saved before eve 1.0

eve 1.0 changed its event format from stream version 26 to 27, and eve 1.0 reads only 27. Migration `0024` marks every chat that has events with `event_format` 26. Chat converts each one once, with eve’s own converter, and saves the result in place:

1. When ChatProvider has loaded the chat list, it reads the ids in `chat.list`’s `unconverted` list.
2. For each chat, one at a time, it reads the events with `chat.get` and converts them, one eve session at a time.
3. It sends them back with a `chat.save` that sets `convert: true`.

Opening a chat that is still waiting converts it first. Both ways share one conversion per chat. A chat that fails keeps its events, and the next launch, or opening it, tries again. Until then it opens converted in memory only: you can read it, but not reply, since a save would mix the two formats. `frontend/src/lib/chat/legacy-events.ts` and `convert-stored-chats.ts` hold the code.

A message you send while the pass at launch is still running waits for it. Conversion gives a chat new event numbers, and `search_chats` and `get_chat` name messages by them, so a turn must not read a chat between its search and its read while the numbers move. A search hit you open later still finds its message: Chat looks for the hit’s text when the message at its number does not hold it.

Before eve converts a session, Chat fixes two shapes eve would draw badly. A turn the app quit during, with no turn end saved, ends as stopped. A step that started and showed nothing before its turn moved on is left out, so it doesn’t show as an empty Sage message. An event with no time takes the time of the event before it, or of the session’s first event with one.

eve’s converter needs each session to start with `session.started`, and it leaves out a reply with no step event around it. Chats from early eve releases can lack both. When eve cannot convert a session as saved, or its result holds fewer of your messages or fewer of Sage’s than the session, Chat keeps what you and Sage said and converts that instead. Tool calls and thinking from that session are left out. Each reply keeps the model its step named.

A long chat takes several writes, so the conversion save writes the new rows to `chat_event_convert` first. One last write then swaps them in. A conversion that fails or stops partway leaves the chat’s events and `event_format` as they were, and the next pass tries again. Sage clears any rows left in `chat_event_convert` at launch. The last write:

- It replaces the chat’s events and sets `event_format` to 27.
- It keeps `updated_at`, so the chat keeps its place in the list and Dream does not read it again.
- Each row’s `saved_at` is the time eve recorded on the event, `meta.at`. An event eve recorded no time for gets none, and a search by time uses `unstamped_until` for it, as for events from before `0019`.
- Event numbers change, so the chat’s message index rows and `chat_index_state` are deleted, and Chat queues the chat to be indexed again right away. A batch of embeddings read before the conversion is dropped: each batch keeps the chat’s `event_format`, and a chat converts only once. A batch for another chat is kept.

The core refuses a conversion with `ChatConverted` once a chat is at 27, so a second conversion can never replace turns saved since. Chat treats that as done.

Until a chat is converted, Sage’s core reads both formats, so search, Dream, `get_chat`, and export work on it.

## Older conversations

`0007` only created `chat_event`, and Sage does not read or convert the old `events` column. A conversation saved before `0007` opens empty in Chat. Search, Dream, the encryption passes, and export all skip it.

## eve’s session files

eve keeps its own copy of each session outside Sage’s SQLite file. Since eve 1.0, Workflow’s local store keeps it in one SQLite file of its own, `world.db`:

- **`make dev`**: under `agent/.eve/.workflow-data/`, always plaintext
- **Packaged app**: under `.eve/.workflow-data` in `~/Library/Application Support/com.wasimxyz.sage/eve/`, encrypted when journal encryption is on

[Encryption at rest](../security/encryption.md#chat-workflow-files) covers how that file is encrypted. The SQLite rows in Sage’s own file are the record Sage encrypts and shows in the Chat screen.

The agent sets `experimental.workflow.retention` to `0`. When a session ends, the store deletes its run’s inputs, outputs, events, and stream. It keeps a record of the run: its id, times, status, step names, model, token counts, and its title. Every session’s title is “Sage chat”, set in `agent/agent/channels/eve.ts`, so the record holds nothing you wrote. A session ends when you delete its chat, or after 30 idle days. When eve compacts a long session, it moves the session to a new run, but the session’s stream stays with its first run, which keeps running until the session ends. So nothing is deleted while the chat can still resume, and ending the session deletes both runs’ data.

Deleting a chat also ends its eve session, found by its `eve_session_id`. Sage does this when the undo toast closes, not when you choose Delete. It takes these steps:

- The id is a workflow run id (`wrun_…`). Sage ignores an id that does not have that shape, so a stored value cannot reach outside the workflow folder.
- In a packaged app, the same write that deletes the chat adds the session id to `chat_session_end`.
- It deletes the session’s files from eve releases before 1.0, which kept a folder of files per session.
- A worker asks the agent to cancel the current turn, then to end the session. Each request can wait up to a second, so the window never waits on them.
- The session leaves `chat_session_end` once the agent answers that it ended it, or that the session is already gone (`404`, `409`, or `410`).
- If the agent is down or refuses, as right after unlock when a delete held over a lock runs before the agent listens, the session stays. Sage tries again after the next delete, or on Chat’s next health check at least 10 seconds after the last try.
- Deleting still succeeds if the files are already gone or the agent is down.

`make dev` starts the agent on its own, so Sage does not end a session there when you delete its chat.

On launch, Sage deletes run folders in `.eve/.workflow-data` that no saved chat points to and that are more than an hour old. Since eve 1.0, the only folders are the ones earlier releases left. `src/eve_sidecar.zig` lists every kind of file it removes.

## Deleting data

Settings > Data counts journal entries, conversations, index rows, and visible memories. Each action stays off until the counts load, and a count of zero turns that action off. Every action asks you to type `delete` in lowercase.

| Action | Command | Deletes | Keeps |
| --- | --- | --- | --- |
| Journal entries | `data.deleteEntries` | Every entry, its embeddings and summary, and the memories Dream wrote from it, including pinned and hidden rows | Memories you added, and all conversations |
| Conversations | `data.deleteConversations` | Every conversation, its transcript, embeddings, and summary, and the memories Dream wrote from it | Memories you added, and journal entries |
| Embeddings | `data.deleteEmbeddings` | `entry_embedding`, `entry_summary`, `chat_embedding`, and `chat_summary` | Entries, conversations, memories, and memory embeddings |
| Memories | `data.deleteMemories` | Every profile sentence, fact, and event, including rows you added and hidden rows, plus Dream times | Entries and conversations |
| Delete all data | `data.deleteAll` | Every entry, conversation, embedding, summary, and memory | The lock password, Touch ID, encryption settings, and Chat instructions |

After the Embeddings wipe, Sage embeds entries and indexes chat messages again, and the next Dream rebuilds summaries. The confirmation closes once the entries are embedded, and the chats are indexed in the background after them. Dream times stay, so Dream does not extract memories again. If Ollama is down, Sage embeds the entries and indexes the chats once Ollama is back.

The Memories count includes visible rows only. If only hidden rows remain, the count is zero and the action stays off.

All five actions refuse while Sage is locked or while a rewrite or file rebuild is running. Each one cancels a running Dream and marks older Dream work as stale, so it cannot write deleted rows back. Each one then rebuilds the SQLite file, and a failed rebuild still reports success because the rows are already gone.

The Conversations and Delete all data actions also remove eve session files and restart Chat. The other actions refresh the open screens in place. Only Delete all data clears local storage, including the saved Chat picker choices, and reloads the window.
