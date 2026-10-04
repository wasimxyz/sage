# Memories

This page explains the optional memory feature: the three kinds of memory, how Dream writes them, how Chat reads them, and how your edits stay after Dream. The code is the memory section of `src/journal.zig`, plus `src/dream.zig`, `agent/agent/memory/`, and `frontend/src/components/memories-screen.tsx`.

A memory build keeps profile facts about you, topic facts about people and subjects, and dated events. Dream writes them from journal entries and chats. You can add and edit them on the Memories screen, and Chat can recall them when it answers.

## Turning memory on

Memory is off by default. Add `SAGE_MEMORY=true` in front of `make dev`, `make build`, or `make package` to build with memory on. The value is compiled into Sage, so changing it takes a new build.

With memory off, Sage hides the Memories screen and rejects memory commands. Dream skips chat embeddings, chat summaries, and memory extraction.

When a new build turns memory off:

1. Sage waits until you unlock, then records that a reset is pending.
2. It deletes saved conversations, memory rows, and eve workflow files, including the development store under `agent/.eve/`.
3. It rebuilds the SQLite file, then records that memory is off.
4. It starts Chat.

If cleanup or the rebuild fails, Chat stays unavailable and the next launch tries the reset again. Journal entries, their embeddings and summaries, and their Dream times stay. The reset also runs the first time an off build starts with no saved mode.

When a new build turns memory on, Sage records a pending refresh and clears Dream times. The next Dream can then extract memories from existing entries and chats. It reuses the current journal embeddings and summaries.

## Memory types

Profile and topic facts live in `semantic_fact`, and events live in `episodic_event`. Every row records its source: a journal entry, a chat, or you.

- **Profile**: lasting sentences about you, such as identity and preferences. Profile sits under one subject, You, and has no embedding.
- **Facts**: lasting sentences about a subject, such as a person, a relationship, or a topic. Each fact has an embedding, so Chat can find it by meaning.
- **Events**: specific things that happened, with a date. Each event has an embedding too.

## How Dream writes memories

In a memory build, [Dream](../dream.md) extracts memories from each changed entry or chat:

1. It asks the summary model for up to 8 profile sentences, 12 facts, and 12 events.
2. It embeds each new fact and event.
3. It saves the rows, skipping any that match a row you pinned or hid.

[How your edits stay after Dream](#how-your-edits-stay-after-dream) covers that last step.

## How Chat uses memories

A memory build reads memories in three ways, and leaves out hidden rows:

- When a session starts, Chat adds up to 50 profile sentences to the system prompt, newest first.
- When you send a message, Chat searches facts and events by meaning and adds the top five of each to the turn.
- The agent can call `facts__search_memories` to search facts and events together. Each hit names its source, and for a journal source the agent can read the entry with `get_journal_entry`.

## The Memories screen

The Memories screen appears under Chat in a memory build. It has two tabs, Facts and Events, and both read the same rows Chat searches. Its addresses are `#/memories`, `#/memories/facts`, and `#/memories/profile` for Facts, and `#/memories/events` for Events.

The Facts tab has two sections:

- **Profile**: the sentences about you, grouped under You
- **Topics**: the facts, grouped by subject

Each section shows one row per subject, with its newest sentence and when that subject last changed. Opening a subject shows every sentence in a panel beside the list, the way Journal opens an entry. Edit lets you add, change, or remove that subject’s sentences, and Delete removes all of them.

The Events tab groups events by how long ago they happened, newest first:

- Recent events are grouped by week, older ones by month, then by year, with titles such as 1 week ago or 2 months ago.
- Events with no date go last, under No date.
- Each row shows the event text and date. When Dream extracted the event, a From line names the entry or chat.

Click an event to edit it. Delete is in that dialog.

## Adding and editing memories

Rows you add or edit are treated differently from rows Dream wrote:

- A row you add is marked as yours and pinned, so later Dream runs keep it.
- Editing a Dream row pins it, and the first edit saves Dream’s original wording.
- Deleting a Dream row hides it instead of removing it, so the same extraction does not come back.
- Deleting a row you added removes it.

Facts and events are embedded when you save them, so Ollama must be running. Otherwise the save fails with “Ollama is not running.” Profile sentences save without Ollama.

## How your edits stay after Dream

When Dream runs again on an entry or chat, it:

1. Collects the current and original wording of that source’s pinned and hidden rows.
2. Deletes the source’s unpinned rows.
3. Skips any extraction whose wording matches a pinned or hidden row, ignoring case and surrounding spaces.
4. For profile, also skips a sentence that already exists on another source.
5. Inserts the rest and records the Dream time.

Pinned rows stay, and hidden rows stay so the same extraction does not come back.

## When you edit an entry or a chat

Editing does not change memories right away. Saving marks the entry or chat for the next Dream, which extracts its memories again under the rules above. [Dream](../dream.md#what-counts-as-changed) explains what counts as a change.

## When you delete a journal entry or a chat

Deleting an entry or a chat also deletes every memory Dream wrote from it, including rows you pinned or hid. Rows you added yourself on the Memories screen stay. A Dream item that started before the delete does not write those rows back.

## Deleting all memories

Settings > Data > Memories deletes every memory, including rows you added and hidden rows. It also clears Dream times, so the next Dream can learn again from the entries and chats that remain.

## Bridge commands

These commands exist only in memory builds. While Sage is locked, they answer “Sage is locked.”

- `memory.list`: returns `{ profile, facts, events }` without hidden rows or embeddings. Each event includes `sourceTitle` when it came from an entry or chat.
- `memory.search`: finds profile sentences, topic subjects and sentences, and event text that contain the query. It leaves out hidden rows, returns newest first, and stops at 25 hits.
- `memory.save`: writes one row. A fact or event is embedded on the embeddings worker queue first, then saved on the event loop thread, while a profile row skips Ollama.
- `memory.delete`: hides a Dream row or deletes a row you added

The agent server’s memory routes are read-only and leave out hidden rows. A build with memory off rejects them.
