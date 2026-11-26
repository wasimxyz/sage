# The Chat frontend

This page explains the React side of Chat: the Chat tab, how the screen streams a turn, when it saves, how it reopens a saved conversation, and what it shows when the agent or Ollama is down. The code is `frontend/src/components/chat-screen.tsx` and the chat functions in `frontend/src/bridge.ts`.

## The pieces of the screen

These paths are under `frontend/src/components/`:

- **ChatProvider** (`chat-provider.tsx`): owns the conversation list, the current selection, the agent health check, and the Chat token from `chat.agentToken`. It reads the model list from OllamaProvider.
- **OllamaProvider** (`ollama-provider.tsx`): checks whether Ollama is running and lists its chat models. Dream and Settings > Models read the same check, so Sage asks Ollama once every 4 seconds, not once per screen.
- **ChatDraftProvider** (`chat/chat-draft.tsx`): holds the text in the message box. A half-typed message stays when you visit Journal, Memories, or Settings and come back. New chat and opening a saved chat start with an empty box, and locking Sage clears it. Only the message box and the Send button read the text. Code that only sets it, such as `ChatTurn`, calls `useChatDraftActions()`, so a keystroke does not redraw the conversation.
- **AppSidebar** (`app-sidebar.tsx`): the sidebar, with the Chat / Journal switch, each tab’s rows and list, and Dream and Settings at the bottom
- **The chat list** (`chat/chat-list.tsx`): one row per saved chat, in the sidebar’s Chat tab
- **ChatLayout** (`chat-layout.tsx`): the Chat tab’s main pane: the header, then `ChatScreen` with the open chat or a new one
- **ChatRoute** (`chat-route.tsx`): opens Chat. AppShell (`app-shell.tsx`) mounts it the first time Chat shows, and it then stays mounted, hidden, while other screens show. If Chat cannot load or draw, ChatRoute shows “Could not open Chat” with a Reload button, and the rest of Sage keeps working.
- **Chat loader** (`chat-layout-loader.ts`): holds the load of `chat-layout.tsx`. `frontend/src/main.tsx` starts it at launch. Hovering or focusing the Chat tab starts it too, and so does `showChat`.
- **ScreenActive** (`screen-active.tsx`): tells Chat’s parts whether Chat is on screen, so a menu or dialog in Chat closes when Chat hides. The sidebar uses it the same way for the list of the tab that is not showing.
- **Rename dialog** (`chat/rename-chat-dialog.tsx`): one dialog, held by `RenameChatProvider` in AppShell, so the sidebar rows and the open chat’s ⋯ menu share it
- **ChatTurn** (`chat-screen.tsx`): one conversation, connected to the agent through eve’s `useEveAgent` hook
- **ChatDictateButton** and **ChatDictationTail** (`chat/chat-dictation.tsx`): the mic in the message box and the grey words under it, as [Dictating a message](#dictating-a-message) explains

## How Chat loads

Chat’s Markdown, code, math, and diagram rendering is about 1.6 MB, nearly half the startup file, so it sits in a file of its own. Sage opens on Chat, so `frontend/src/main.tsx` starts that load at launch, beside the lock and setup checks. Hovering or focusing the Chat tab starts it too. `showChat` waits for the load before it switches screens, so Chat opens without a spinner.

A module that fails to load stays failed until the page reloads, so a retry in place cannot work. ChatRoute shows the Reload button for that case.

## The Chat tab

The Chat tab’s rows are New chat, Search, and, in a memory build, Memories. Search shows ⌘K and New chat shows ⌘N when you hover over the row or focus it. Under the rows, a gray Conversations label heads the chat list. Dream and Settings sit at the bottom, as on the Journal tab. [The journal](../journal.md) covers the sidebar as a whole.

Each row shows the chat’s title and the day it last changed, such as Today, 3 days ago, or Nov 8, as [How dates read](../journal.md#how-dates-read) explains. Click a row to open that chat in the main pane. The open chat’s row is highlighted while Chat is on screen. While the list loads, it shows placeholder rows, and with no chats it says “No conversations yet.” If the list cannot load, it says “Could not load chats.” with a Try again button, so a failed read never looks like an empty list.

New chat opens an empty conversation, and so does ⌘N in the Chat tab.

Right-click a saved chat for Rename and Delete. With a chat focused, Return renames it and ⌘⌫ deletes it:

- **Rename** opens a dialog and calls `chat.rename`. The row stays where it is, and later Dream runs keep that title.
- **Delete** hides the chat and shows a toast with its title and Undo for 5 seconds. When the toast closes, Sage calls `chat.delete`. If Sage locks or quits first, it saves the delete and runs it after the next unlock. That removes the SQLite rows, the memories Dream took from the chat, and the chat’s eve session files.

Deleting the open chat shows a new chat at once. Undo brings the chat back and reopens it. Deleting chats from Settings clears the open chat the same way.

The Chat tab also holds [Memories](memories.md#the-memories-screen). While Memories is open, the Chat tab stays current and the Memories row is highlighted. The Chat tab keeps what was last open in it, so it goes back to Memories if Memories was the last screen open there.

## The open chat

Sage opens on a new chat. Its header is empty. Today’s date, such as Monday, November 23, and a greeting sit above the message box, in the middle of the pane. The greeting follows the hour:

- “Good morning.” from 5 AM to noon
- “Good afternoon.” from noon to 5 PM
- “Good evening.” the rest of the day

The greeting turns over at 5 AM, noon, and 5 PM, and the date at midnight. Coming back to the window after the Mac has slept reads the clock again. `frontend/src/lib/greeting.ts` holds the hours, and `frontend/src/hooks/use-greeting-now.ts` holds the timer.

Faint dot clouds sit still near the edges of a new chat. They are the lock screen’s clouds (`clouds.tsx`) with `tone="faint"`, and `frontend/src/index.css` sets their colors for light and dark. The first message moves the box to the bottom of the pane. The Ollama and agent warnings show above the box, as they do on a saved chat.

A saved chat’s header shows its title, the day it last changed in lighter text, such as Friday, October 2, 2026, and a ⋯ menu with Rename and Delete.

The transcript, a shadcn `MessageScroller`, opens at the chat’s latest message. A message you send moves near the top of the pane, under the end of the previous reply. Its reply comes in below it, and once the reply fills the pane, the transcript follows it. Scrolling up stops the transcript there, and the arrow at the bottom returns to the latest message.

Visiting another screen does not stop the chat. The conversation stays in place, out of sight, so a reply that is still coming in keeps streaming and saving. When you come back to Chat, the transcript and its scroll position are as you left them. Opening the chat that is already open, from its row or from a search hit, leaves the conversation as it is. A menu, a dialog, or a full-screen table or diagram that was open in Chat closes when you leave.

The address bar follows Chat:

- `#/chat/new`: a new chat
- `#/chat/<id>`: that saved chat

`#/chat`, `#/home`, an empty hash, and any hash Sage does not know open `#/chat/new`. When a new chat saves, `#/chat/new` becomes `#/chat/<id>` without adding a history entry. Back and Forward move between the chats you opened, and reloading the page reopens the same view. After an unlock, the hash brings back the screen from before the lock. The rules live in `frontend/src/lib/route.ts` and `frontend/src/hooks/use-route-sync.ts`.

## Dictating a message

A mic button sits in the message box, beside the model picker. Only a live conversation has one, and it is hidden on a Mac that cannot dictate. ⌘D does the same while Chat is on screen. [Dictation](../dictation.md) explains the engine and the permission.

Dictated words go to the end of the box as they settle, with the space they need. You press Send as usual. The grey words, the ones that have not settled, show in a muted line under the box. They are not in the box, so Send never carries them.

Dictation ends when you press Send, open another chat, or leave Chat for another screen. A Send or a change of chat drops the grey words, and the words that settled stay in the box. It also ends when Dream starts and turns the box off. The code in `chat/chat-dictation.tsx` registers the box with `DictationProvider` as the place the words go, and only one dictation runs at a time, so the entry mic is off while this one is on.

## Search

⌘K opens the search dialog, and so does the Search row in the sidebar. The dialog opens on the tab for the screen behind it: Conversations on Chat, Journal on Journal, Memories on Memories, and All in Settings. All stays one click away. `searchTabFor` in `frontend/src/lib/search-hits.ts` picks the tab.

Each tab calls its own command:

- **Journal**: `journal.search`
- **Conversations**: `chat.search`
- **Memories**: `memory.search`
- **All**: all three, with up to 25 hits from each

Switching tabs without changing the query reuses the lists already loaded.

Choosing a hit opens it:

- A journal hit opens the Journal tab with that entry.
- A conversation hit opens the Chat tab with that conversation. If the hit has a `seq`, Chat scrolls to the matching message, and a title-only hit opens it without scrolling. A hit in the chat that is already open scrolls to its message without reading the chat again.
- A memory hit opens that memory on the Memories screen, in the Chat tab. Profile and topic hits open the subject pane, and an event hit opens its edit dialog.

## Streaming a turn

`useEveAgent` manages the session with the eve server. The screen passes it:

- A `headers` callback that sends the agent-server token as `Authorization: Bearer`, plus the headers described in [The eve app](eve-app.md#choosing-the-model-for-each-request)
- The saved events and session, when you reopen a conversation
- Lifecycle callbacks that save the turn
- A `host`: empty during `make dev` so `/eve` goes through the Vite proxy, or `http://127.0.0.1:2001` in a packaged app

Once a chat has saved, each request also sends `x-sage-chat-id`, so `search_chats` leaves that chat out.

A reopened conversation waits for the token before it resumes the stream. After you send, Chat shows a pulsing leaf where the reply will start. The first text, thinking, or tool row replaces it.

## Tool rows

When the model searches the journal or past chats, or reads an entry or a chat, Chat draws one row for the step. A row stays closed until you click it. While the step runs, its label shimmers and there is nothing to open.

A search row opens to a card. The first line says what the model searched for: the words in quotes, the days when it searched by time, or both. Each entry it found follows, with its title and a short date such as “Sun, Sep 27”. A search with no matches says “No matching entries”. The note the model reads about its results stays out of the card.

Reads that come one after the other share one row, such as “Read 3 entries”. Thinking or text between two reads starts a new row. An entry the model reads twice shows once. Click an entry to open it in the Journal tab.

A search of past chats works the same way. Its row says “Searched past chats”, and each chat it found shows its title and the date of its best match. Reads of chats share a row such as “Read 2 past chats”, apart from reads of entries. Click a chat to open it, scrolled to the message the model found. A search with no matches says “No matching chats”.

A failed step shows its error as one sentence inside the row. A failed read in a group shows as “Could not read 1 entry”. Other tools, such as `facts__search_memories`, show their parameters and result as plain text.

`frontend/src/lib/chat/assistant-runs.ts` decides which parts share a row. `frontend/src/components/chat/journal-tool-cards.tsx` and `chat-tool-cards.tsx` draw the cards.

## When the screen saves

Saving happens in the lifecycle callbacks, never in the middle of a stream:

1. `onSessionChange` saves the eve session id and stream index when eve assigns them.
2. `onFinish` saves the events added since the last successful save, when a turn completes.
3. The first save of a new conversation also sets the title from the first message, cut to 60 characters.
4. After a save that adds events, the screen calls `embeddings.generate` with the chat’s id until Sage has indexed every new message for `search_chats`. It does not wait, so the next save is not held up. [Chat storage](storage.md#the-message-index) covers what happens when that fails.

Later saves leave the title alone. [Dream](../dream.md) may replace it with a generated title unless you renamed the chat. The chat list reloads when Dream finishes.

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

OllamaProvider checks `embeddings.status` every 4 seconds while the window is visible, then lists chat models with `ollama.models` when local AI is running. A hidden window skips the check and runs it once when it comes back. If local AI is down, Chat shows a notice above the prompt with “Local AI isn’t running” and a “Start local AI” button. If there are no local chat models, the notice says “No chat models” and asks you to download one in Settings › Models. Either way the composer stays off. The model list reloads as soon as the start succeeds, as [Models](../models.md#when-ollama-is-not-running) explains.

## When the agent is down

Chat checks `/eve/v1/health` every 4 seconds while the window is visible and needs a JSON body of `{ "ok": true }`. A 200 HTML page from a missing server does not count. A hidden window skips the check and runs it once when it comes back.

While a packaged Chat server is starting, Chat checks every 250 ms and stays in its checking state, so the first page load does not flash a warning. After 8 seconds with no healthy answer, Chat shows the warning. A `chat.agent` status other than `ready` shows it at once.

A packaged app also asks `chat.agent` on every check, and Chat is ready only when that command reports `ready` and health answers. Health is public, so another program on port 2001 could answer it, but only `chat.agent` knows whether Sage started its own server. A `port_busy` status keeps Chat down with “Port 2001 is already in use, so Chat cannot start.”

When the agent is down, a warning above the prompt says why and the composer stays off:

- **During `make dev`**: start the agent with `npm --prefix agent run dev`. Health alone decides, because the agent runs on its own.
- **In a packaged app**: the reason comes from `chat.agent`. This copy may be incomplete, the app may need a rebuild so the agent is inside the bundle, or port 2001 may be taken.

A packaged build has no Vite proxy, so the page’s `connect-src` list includes the exact origin `http://127.0.0.1:2001`.
