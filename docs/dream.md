# Dream

This page explains Dream, the job that catches up on entries and chats that changed since its last run. It covers what Dream does in each build, how you start it, and what the sidebar shows while it runs. The code is `src/dream.zig`, and the sidebar button is `frontend/src/components/dream-nav.tsx`.

## What Dream does

Dream does different work depending on whether the build has memory on. [Memories](agent/memories.md) explains that build option.

In every build, Dream:

- Refreshes stale embeddings for each changed entry
- Writes a short summary of each changed entry and embeds it. Chat search ranks these summaries, so an entry with no summary cannot show up in Chat.
- Writes a short title for each changed chat from its last four User and Sage messages. It skips chats you renamed.

In a memory build, Dream also:

- Embeds each changed chat and writes a summary of it
- Extracts up to 8 profile sentences, 12 facts, and 12 events from each changed entry and chat
- Embeds each new fact and event. Profile sentences are not embedded.

## What counts as changed

An entry or chat is pending when its `updated_at` is newer than the time Dream last finished it. Dream records that time per source in the `dream_state` table.

- Saving an entry bumps its `updated_at`.
- Saving a chat bumps its `updated_at` only when the transcript changes. Reopening a chat or changing its model does not.
- A chat with no User or Sage text is skipped until its transcript changes.

Dream also repairs sources whose embeddings or summaries are missing, for example after Settings > Data deletes them. That repair does not extract memories again.

## How a run works

1. You click Dream in the sidebar and confirm.
2. `dream.start` checks that Ollama is running and that the summary and embedding models are pulled.
3. Sage lists the pending entries and chats and answers with the total.
4. A worker thread handles one item at a time, and the loop thread saves each result.
5. The sidebar shows Dreaming… and the percent complete, from `dream:progress` events.
6. A message reports how many facts and events Dream saved, and how many items failed.

The summary model is `qwen3.5:9b` unless `SAGE_SUMMARY_MODEL` names another one. Each call has its own time limit: 10 seconds for the status check, 2 minutes for an embedding or a title, and 5 minutes for a summary or an extraction.

## When Dream cannot run

- **Ollama is down**: the Dream button is off, with a tooltip that says “Start Ollama so Sage can Dream.”
- **A model is missing**: Dream stops with a message such as “The summary model is not pulled. Run: ollama pull qwen3.5:9b”.
- **Sage is locked**: `dream.start` and `dream.status` answer “Sage is locked.”

The Chat screen and Settings > Models can start Ollama for you, as [Models](models.md#when-ollama-is-not-running) explains.

## When data is deleted

Every action in Settings > Data cancels a running Dream. A Dream item that started before a delete does not write the deleted rows back. Deleting an entry or a chat also deletes the memories Dream wrote from it, as [Memories](agent/memories.md#when-you-delete-a-journal-entry-or-a-chat) explains.

## Bridge commands

- `dream.start`: checks Ollama and the models, then starts a run and answers with the number of items
- `dream.status`: whether a run is going, how many items are done out of the total, and when Dream last finished
