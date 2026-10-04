# Chat at a glance

This page explains Sage’s Chat feature: what it does, the three processes involved, and how a question gets an answer from your journal. The code lives in `frontend/src/components/chat-screen.tsx`, `agent/`, and `src/agent_server.zig`.

Chat lets you ask questions about what you have written, and a local agent answers from your journal. Nothing leaves your Mac: Ollama runs the model, a local Node.js process runs the agent, and Sage stores transcripts in SQLite. Memories are off by default, as [Memories](memories.md) explains.

## The three processes

Chat involves three processes on your Mac:

- **Sage**: the app itself, which owns the journal file and the lock
- **The eve agent**: a Node.js process in `agent/` that runs the conversation and calls tools
- **Ollama**: the local model server that runs the chat model, the summary model, and the embedding model

## How a question gets an answer

1. You type a question in the Chat screen.
2. The frontend sends it to the eve agent: through the Vite `/eve` proxy to port 2000 during `make dev`, or straight to `127.0.0.1:2001` in a packaged app.
3. The agent calls the chat model you picked, served by Ollama.
4. When the model wants to look something up, it calls `search_journal` or `get_journal_entry`, and in a memory build `facts__search_memories`.
5. The tool asks Sage’s local agent server, which searches entry summaries or reads one entry and returns decrypted text.
6. The answer streams back to the Chat screen.
7. When the turn finishes, the frontend saves the transcript through the `chat.save` bridge command.

In a memory build, profile facts and the top matching facts and events also enter the prompt before the model runs.

## What Chat searches

Chat searches short summaries of your entries, not the full entries. [Dream](../dream.md) writes those summaries, so an entry Dream has not reached yet does not show up in Chat. Dream also writes chat titles, and in a memory build it extracts the facts and events Chat can recall.

## What is stored

Each conversation is one row in `chat_conversation`, plus one `chat_event` row per event. The conversation row holds the title, the eve session to resume, and the last model and Thinking setting. Titles and events are encrypted with the same data key as journal entries when encryption is on; [Chat storage](storage.md) covers the details.

## The rest of the Chat docs

- [The eve app](eve-app.md): the agent’s files, model selection, tools, and configuration
- [The Chat frontend](frontend.md): how the React screen streams, saves, and reopens conversations
- [Chat storage](storage.md): the tables, the save protocol, export, and deleting data
- [Memories](memories.md): the optional Facts and Events feature, and how your edits stay after Dream
- [Local agent server](../security/agent-server.md): how the agent reads the journal and how its token is checked
