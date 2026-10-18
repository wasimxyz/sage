# The Chat frontend

This page explains the React side of Chat: how the screen streams a turn, when it saves, how it reopens a saved conversation, and what it shows when the agent or Ollama is down. The code is `frontend/src/components/chat-screen.tsx` and the chat functions in `frontend/src/bridge.ts`.

## The pieces of the screen

These paths are under `frontend/src/components/`:

- **ChatProvider** (`chat-provider.tsx`): owns the conversation list, the current selection, the model list, the agent health check, and the Chat token from `chat.agentToken`
- **ChatDraftProvider** (`chat/chat-draft.tsx`): holds the text in the message box. It sits above the screens, so a half-typed message stays when you visit Home or Journal and come back. New chat and opening a saved chat start with an empty box, and locking Sage clears it.
- **ChatLayout** (`chat-layout.tsx`): the chat list on the left and the panel on the right. It uses the same list-and-panel layout as Journal (`split-view.tsx`, `list-row.tsx`).
- **The chat list** (`chat/chat-list.tsx`): one row per saved chat, with a New chat button above it
- **The chat panel**: the header in `chat-layout.tsx` and the conversation in `chat-screen.tsx`
- **Rename dialog** (`chat/rename-chat-dialog.tsx`): one dialog, shared by the rows and the panel’s ⋯ menu
- **ChatTurn** (`chat-screen.tsx`): one conversation, connected to the agent through eve’s `useEveAgent` hook

## The chat list

The sidebar stays on the main menu while Chat is open. Search is in that menu, as on every screen.

Each row shows the chat’s title and the day it last changed, such as Today, Yesterday, or Oct 2. Click a row to open that chat in the panel. The open chat’s row is highlighted. While the list loads, it shows placeholder rows, and with no chats it says “No chats yet.”

New chat opens an empty conversation, and so does ⌘N while Chat is open.

Right-click a saved chat for Rename and Delete. With a chat focused, Return renames it and ⌘⌫ deletes it:

- **Rename** opens a dialog and calls `chat.rename`. The row stays where it is, and later Dream runs keep that title.
- **Delete** hides the chat and shows a toast with its title and Undo for 5 seconds. When the toast closes, Sage calls `chat.delete`. If Sage locks or quits first, it saves the delete and runs it after the next unlock. That removes the SQLite rows, the memories Dream took from the chat, and the chat’s eve session files.

Deleting the open chat returns the panel to New chat at once. Undo brings the chat back and reopens it. Deleting a chat while the panel is closed leaves the panel closed.

## The chat panel

The first time you open Chat, the panel is open on an empty new chat, beside the list. After that, Chat shows what you left: the same chat open, or the list alone if you closed the panel.

The panel header has these controls:

- **Close** (⌥⌘B) closes the panel and keeps the chat selected. The list then fills the page. ⌥⌘B opens it again.
- **Full screen** hides the list. Back, in the same place, brings the list back at the size you last chose. Full screen ends when you close the panel or leave Chat.
- **The title** is “New chat” until the first message saves.
- **The ⋯ menu** has Rename and Delete. A new chat has no ⋯ menu, because there is nothing to rename or delete yet.

Drag the divider to resize the panel, and double-click it to reset the split. In a narrow window, the list sits above the panel.

Closing the panel and opening it again reads the chat from storage, so the transcript shows every turn, including ones sent while the panel was open.

The address bar follows the panel:

- `#/chat`: the list alone
- `#/chat/new`: the panel open on a new chat
- `#/chat/<id>`: the panel open on that saved chat

When a new chat saves, `#/chat/new` becomes `#/chat/<id>` without adding a history entry. Back and Forward move between the chats you opened, and reloading the page reopens the same view.

## Search

⌘K opens the search dialog, and so does Search in the sidebar. Each tab calls its own command:

- **Journal**: `journal.search`
- **Conversations**: `chat.search`
- **Memories**: `memory.search`
- **All**: all three, with up to 25 hits from each

Switching tabs without changing the query reuses the lists already loaded.

Choosing a hit opens it:

- A journal hit opens that entry.
- A conversation hit opens that conversation in the panel. If the hit has a `seq`, Chat scrolls to the matching message, and a title-only hit opens it without scrolling.
- A memory hit opens that memory. Profile and topic hits open the subject pane, and an event hit opens its edit dialog.

## Streaming a turn

`useEveAgent` manages the session with the eve server. The screen passes it:

- A `headers` callback that sends the agent-server token as `Authorization: Bearer`, plus the headers described in [The eve app](eve-app.md#choosing-the-model-for-each-request)
- The saved events and session, when you reopen a conversation
- Lifecycle callbacks that save the turn
- A `host`: empty during `make dev` so `/eve` goes through the Vite proxy, or `http://127.0.0.1:2001` in a packaged app

A reopened conversation waits for the token before it resumes the stream. After you send, Chat shows a pulsing leaf where the reply will start. The first text, thinking, or tool row replaces it.

## When the screen saves

Saving happens in the lifecycle callbacks, never in the middle of a stream:

1. `onSessionChange` saves the eve session id and stream index when eve assigns them.
2. `onFinish` saves the events added since the last successful save, when a turn completes.
3. The first save of a new conversation also sets the title from the first message, cut to 60 characters.

Later saves leave the title alone. [Dream](../dream.md) may replace it with a generated title unless you renamed the chat. The Chat list and Home reload when Dream finishes.

The same callbacks run when a reopened conversation resumes. The screen skips the write when the title, session, stream index, and events match what is stored, so opening a row does not move it to the top of the list. Saves run one after another through a promise chain, so a save never overtakes the one before it.

## Reopening a conversation

Opening a row reads it with `chat.get` and remounts `ChatTurn` with the stored events and session. The hook shows the stored transcript and resumes the session, so the next message continues where the last one ended. [Chat storage](storage.md#resuming-a-conversation) covers the storage side.

## Recovering a session that ended

An eve session can end for good, for example after a model call error or an eve upgrade that cannot replay it. eve then refuses the session, either when a reopened conversation resumes it or when you send a message:

- `409 session_not_active`: the session ended.
- `409 session_stranded`: an older eve version built it.
- `410 session_expired`: eve deleted its history after the session ended.
- `404 Session not found.`: the workflow files are gone. eve's client retries this one for about 38 seconds before it reports it.

Chat recovers once per open conversation:

1. Chat clears the stored session id.
2. It remounts without resuming. If you were sending a message, it sends it again.
3. Each message in the new session includes the saved transcript as eve `clientContext`, so the model can read the earlier conversation.

Moving to eve 0.80 ended every saved session at once: the new workflow storage deletes files that older versions wrote. Migration 18 clears every stored session id, so reopened conversations start fresh without that 38-second wait.

The saved log then holds two sessions, and both number their turns from `turn_0`. Chat renames repeated turn ids on screen (`turn_0#1`) so new turns do not replace old ones, while the stored events keep their original ids. `frontend/src/lib/chat/session-recovery.ts` has the details.

## The model picker

The picker lists pulled chat models from `ollama.models`, without the embedding model or cloud models. It has three rows:

- **Context length**: opens a menu from 4K to 256K. You can change it only on a new chat, before the first message.
- **Thinking**: a switch
- **Model**: opens a menu with a search box and the model list

A new chat starts with the last model, Thinking setting, and context length, saved in local storage under `sage-chat-prefs:v1`. With nothing saved yet, it uses `qwen3.5:9b` if that model is pulled, otherwise the first chat model, with a context length of `32768`. Delete all data clears that storage.

Each saved conversation keeps its own model, Thinking setting, and context length, and opening it restores them:

- Changing the model or Thinking on a saved chat writes it through `chat.savePrefs` and does not move the row in the list.
- The context length is set before the first message and never changes after that.
- Older rows with no stored model use the last `step.started` event’s `modelId`, without eve’s `ollama/` prefix.
- Older rows with no Thinking setting use the last choice for new chats, and older rows with no context length use `32768`.

## When Ollama is down

Chat checks `embeddings.status` every 4 seconds, then lists chat models with `ollama.models` when Ollama is running. If Ollama is down, or has no local chat models, Chat shows a notice above the prompt and turns off the composer. The model list reloads as soon as Start Ollama succeeds, as [Models](../models.md#when-ollama-is-not-running) explains.

## When the agent is down

Chat checks `/eve/v1/health` every 4 seconds and needs a JSON body of `{ "ok": true }`. A 200 HTML page from a missing server does not count.

While a packaged Chat server is starting, Chat checks every 250 ms and stays in its checking state, so the first page load does not flash a warning. After 8 seconds with no healthy answer, Chat shows the warning. A `chat.agent` status other than `ready` shows it at once.

A packaged app also asks `chat.agent` on every check, and Chat is ready only when that command reports `ready` and health answers. Health is public, so another program on port 2001 could answer it, but only `chat.agent` knows whether Sage started its own server. A `port_busy` status keeps Chat down with “Port 2001 is already in use, so Chat cannot start.”

When the agent is down, a warning above the prompt says why and the composer stays off:

- **During `make dev`**: start the agent with `npm --prefix agent run dev`. Health alone decides, because the agent runs on its own.
- **In a packaged app**: the reason comes from `chat.agent`. This copy may be incomplete, the app may need a rebuild so the agent is inside the bundle, or port 2001 may be taken.

A packaged build has no Vite proxy, so the page’s `connect-src` list includes the exact origin `http://127.0.0.1:2001`.
