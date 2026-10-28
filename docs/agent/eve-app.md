# The eve app

This page explains the `agent/` directory: the files eve expects, how the chat model is chosen for each request, which tools the agent has, and how Chat is configured and started. eve’s own reference ships with the dependency at `agent/node_modules/eve/docs/`.

## File layout

An eve agent is a directory of files, and `agent/agent/` follows that layout:

- `agent.ts`: runtime config, including the model choice for each request
- `instructions.md`: the system prompt
- `instructions/profile.ts`: loads profile facts in a memory build
- `instructions/user.ts`: loads extra instructions from Settings > Agent when a session starts
- `instructions/memory.ts`: adds memory guidance in a memory build
- `instructions/today.ts`: adds today’s date to every turn
- `tools/`: one file per tool: `search_journal.ts`, `get_journal_entry.ts`, `search_chats.ts`, and `get_chat.ts`
- `memory/`: `facts.ts` and `episodic.ts`, which recall facts and dated events in a memory build. They only read. Dream and the Memories screen write.
- `channels/eve.ts`: the HTTP channel the frontend talks to, with its token check

Shared code lives in `agent/agent/lib/`:

- `sage.ts`: the client every tool uses to reach Sage’s agent server
- `bearer.ts`: the constant-time token compare and the `fetch` wrapper that adds the token
- `workflow-guard.ts` and `workflow-guard-preload.ts`: the token check on eve’s workflow routes, loaded before the server starts
- `local-models.ts`: checks the Ollama address and refuses cloud or missing models
- `memory-feature.ts` and `memory-feature-state.ts`: ask Sage whether this build has memory on, and treat a failed request as off
- `memory-text.ts`: picks the last user message, which memory recall searches with
- `when.ts`: turns a phrase such as “last week” into a span of days, turns days into the times a chat search needs, and reads today’s date
- `search-result.ts`: adds the span, today’s date, and a plain-language note to a dated search
- `ids.ts`: writes and reads the `entry-12` and `chat-12` ids the tools use
- `chat-result.ts`: shapes chat search results and chat reads, with a plain-language note

## Choosing the model for each request

The Chat screen sends these headers with each request:

- `x-sage-model`: the picked model
- `x-sage-think`: the Thinking switch, `1` or `0`
- `x-sage-context-length`: the conversation’s context length
- `x-sage-chat-id`: the saved chat’s id, once the chat has saved. `search_chats` uses it to leave that chat out, as [Searching past chats](#searching-past-chats) explains.

Three pieces pass the first three to Ollama:

1. `channels/eve.ts` reads the headers during the token check and stores them as session attributes named `model`, `think`, `contextLength`, and `chatId`.
2. `agent.ts` picks the model with `defineDynamic` on `step.started`, reading those attributes.
3. The handler returns the Ollama model and sets `modelContextWindowTokens` from the context length, because Ollama models are not in the AI Gateway catalog. It passes `think` and `options.num_ctx` through `providerOptions.ollama`, so Ollama turns thinking on or off and allocates the picked window.

When a header is missing or invalid, the agent falls back:

- **Model**: `OLLAMA_MODEL` from the environment, then `qwen3.5:9b`. An `ollama/` prefix from eve is dropped before the call.
- **Thinking**: on
- **Context length**: `OLLAMA_CONTEXT_WINDOW`, then `32768`. A header above the picker maximum of 262144 tokens is capped there, so a caller cannot make Ollama allocate more than Chat offers. `OLLAMA_CONTEXT_WINDOW` is your own setting and is not capped.

Before each model call, the agent asks Ollama’s `/api/tags` about the model. It refuses a model that runs in the cloud or is not pulled.

## Tools

Four tools read the journal and past chats through Sage’s agent server:

- **`search_journal`**: finds entries by meaning, by time, or both. Each entry has an id, title, date, and snippet. A search by meaning also returns a score. It ranks entry summaries, so an entry without one does not appear. An empty result with no `note` tells the model to suggest Dream in the sidebar.
- **`get_journal_entry`**: reads one full entry by id
- **`search_chats`**: finds what was said in earlier chats, by meaning, by time, or both
- **`get_chat`**: reads part of one earlier chat by id

### Ids

Sage numbers entries and chats separately, so a plain 12 could be either. The tools name them `entry-12` and `chat-12`, in every build:

- `get_journal_entry` takes `entry-12`, or a plain number from a chat saved before these ids. A chat id gets an error that says to call `get_chat`.
- `get_chat` takes only `chat-12`. An entry id gets an error that says to call `get_journal_entry`, and a plain number gets one that shows the right shape.
- `facts__search_memories` names each hit’s source the same way, or `you` for a memory you added.

`lib/ids.ts` adds the prefixes. The agent server’s answers keep plain numbers.

A search by meaning leaves out summaries that score under 0.45 against the query. That number comes from `nomic-embed-text`, so another embedding model needs its own value (`min_summary_score` in `src/journal.zig`).

### Searching by time

`search_journal` takes an optional `when`: the user’s own words for a time, such as `last week`, `in March`, or `recently`. The tool turns those words into a span of days, so the model never does date math. The rules live in `lib/when.ts`:

- Weeks run Monday to Sunday. `last week` is the week before this one. `past week` and `the last week` are the last 7 days. Months and years work the same way.
- `recently` and `lately` mean the last 14 days. `a few` means 3, so `the last few days` is the last 3 days.
- A month name with no year means the latest one that has started. `last March` means one that is over.
- A month and a day, such as `March 3`, means the latest one that has come.
- `last weekend` is the Saturday and Sunday of the week before this one. `this weekend` works once Saturday has come, and `this past weekend` always does.
- `since March` runs from the start of March to today.
- Seasons, weekdays, `3 weeks ago`, and `past 2 months` work too.
- Dates always work: `2026-03`, `2026-03-14`, or `2026-03-01..2026-03-15`. A range needs a date on both sides.

A phrase the tool can’t read returns an error that asks for `YYYY-MM-DD..YYYY-MM-DD`.

Every dated result names the days it searched as `range`, and today’s date, so a wrong reading is easy to spot. What comes back depends on the arguments:

- **`when` and `query`**: only entries dated in the span are ranked by meaning.
- **`when` alone**: entries picked evenly from the ones in the span, oldest first, 10 by default. A stretch with many entries gets more of them. An entry without a summary shows the start of its body.
- **`query` alone**: the same as before, a plain list of entries. When the list is empty because every summary scored under the cutoff, or none could be compared, the result adds a `note` that says so.

When the entries don’t tell the whole story, the result adds a `note` in plain words:

- Matches under the cutoff were left out, with how many.
- Only some of the matches or entries are shown, with the total.
- Entries in the span have no summary yet, so a search by meaning can’t see them.
- Entries have a summary the search can’t compare with the query, such as one made with another embedding model. Leave out `query` to read them.
- Nothing is dated in the span. The result also gives `nearest`, the dates of the entries on either side, so the model can offer them.

Every turn also starts with a line from `instructions/today.ts`, such as “Today is Sunday, October 25, 2026.” Both read the date through `todayFromEnv()`, which uses the Mac’s clock. Evals set `SAGE_TODAY` to pin it. Packaged Chat never does.

### Searching past chats

`search_chats` and `get_chat` are on in every build. `search_journal` never searches chats.

Sage keeps one embedding for each User and Sage message, so a search ranks both what you said and what Sage replied. [Chat storage](storage.md#the-message-index) covers when messages get their embeddings. A search works like `search_journal`:

- **`query`**: messages are ranked by meaning. Messages that score under 0.45 are left out (`min_chat_score` in `src/journal.zig`), and each chat shows at most 2 messages. Results are grouped by chat, and each hit has a message number.
- **`when` alone**: the chats from that time, picked evenly, oldest first, 10 by default. Each shows Dream’s summary, or its first message when Dream hasn’t summarized it.
- **`when` and `query`**: only messages from that time are ranked.

`when` takes the same words as in `search_journal`. A message counts as inside the time when it was saved inside it. A message saved before Sage kept that time counts when it could have been saved inside the time, as [Chat storage](storage.md) explains. The tool turns the days into times on this Mac’s clock, so a day that starts or ends daylight saving time still runs midnight to midnight.

The chat you are in is left out. The Chat screen names it with `x-sage-chat-id`, and a new chat that hasn’t saved yet has nothing to leave out.

`get_chat` takes a chat id and an optional message number:

- **With a message number**: that message and up to 2 User and Sage messages on each side
- **Without one**: the chat’s summary, when Dream wrote one, and its last 5 messages

Each message is cut at 4,000 bytes. A `note` says how many messages are left out on each side, which message number to use to read more, and whether any were cut. Message numbers have gaps, so the tool asks the model to use only a number it was shown. A message number that isn’t one gets a different error from a chat that doesn’t exist.

The instructions tell the model to use `search_chats` when you point back to an earlier conversation, such as “last time” or “we talked about”, or ask what you’ve discussed.

In a memory build, the facts slot also adds **`facts__search_memories`**. It searches facts and dated events, and each result names its source with an id, as [Ids](#ids) explains. `get_journal_entry` reads an entry source, and `get_chat` reads a chat source.

All tools reach the agent server through `lib/sage.ts`, over a Unix socket with the bearer token. `agent.ts` sets `defaultTools: false`, so eve’s built-in tools stay off.

Sage has no sandbox. The built-in tools that need one, such as bash and file access, are the ones that stay off, and the journal tools reach Sage over the socket. `npm --prefix agent run build` passes `--skip-sandbox-prewarm`, because `eve build` otherwise tries to prepare a virtual machine for eve’s default sandbox, and Sage does not install the `microsandbox` package. A tool that needs a sandbox would have to drop that flag and install a provider first.

The journal and chat tools are always on. Memory slots, the memory search tool, and profile recall turn on only when `/features` reports that memory is on. That endpoint and the `features.get` bridge command read the same compiled value, and a failed lookup leaves memory off.

## Authentication

Every Chat request must send Sage’s agent-server token as `Authorization: Bearer`. `channels/eve.ts` checks it on every session route under `eve dev` and the packaged server, and a missing or wrong token returns 401. `GET /eve/v1/health` stays public and reports only that the agent is up.

eve also serves its workflow routes under `/.well-known/workflow/` on the same port, and the channel never sees them. `lib/workflow-guard.ts` checks the same token there. [Local agent server](../security/agent-server.md#the-chat-port) covers that guard, where the token comes from in each mode, and the dev terminal hook.

Packaged Chat loads from `zero://app`, so the channel allows cross-origin requests (CORS) from that origin for GET and POST. It echoes the request headers the web view sends, including `authorization`. In development, Chat stays same-origin through the Vite `/eve` proxy and does not need CORS.

## Configuration

`agent/.env.example` lists three settings for `eve dev`. Copy it to `agent/.env.local` to change them:

- `OLLAMA_BASE_URL`: Ollama’s native `/api` prefix. It must be a loopback address (`127.0.0.1`, `localhost`, or `::1`), or the agent stops. An empty value uses `http://127.0.0.1:11434/api`. A leftover `/v1` suffix is rewritten to `/api`, so older env files still work.
- `OLLAMA_MODEL`: the fallback chat model
- `OLLAMA_CONTEXT_WINDOW`: the fallback context length

Packaged Chat does not read `agent/.env.local` or inherit Sage’s environment. It always calls Ollama at `http://127.0.0.1:11434/api` with no Ollama API key. The model and context length come from the Chat request, then from the defaults in `agent.ts`.

Memory is a build option, not an agent setting, as [Memories](memories.md#turning-memory-on) explains.

## How Chat starts in development

`make dev` starts `eve dev` on port 2000, then `native dev`. You can also start the agent alone with `npm --prefix agent run dev`. The Vite dev server proxies `/eve` to that port, so the frontend uses same-origin paths for fetches and for the `useEveAgent` hook.

`eve dev` writes its session files to `agent/.eve/` in plaintext, because it never receives the world key.

## How Chat starts in a packaged app

A packaged app starts the built Chat server, `.output/server/index.mjs`, on `127.0.0.1:2001` with the bundled Node.js. That is the same server `eve start` runs. Sage starts the file itself so it can pass the token to that process through a pipe and check its process id on each journal call.

The working directory is `~/Library/Application Support/com.wasimxyz.sage/eve/`. It points at the agent source, `.output/`, and `node_modules`, all copied into the app bundle.

That `node_modules` is a production install: `make package` runs `npm --prefix agent install --omit=dev`, so `typescript`, `@types`, Biome, and `@vercel/blob` never reach the bundle. Run `npm --prefix agent install` again before `make check`, which needs `typescript` and Biome.

Chat calls `http://127.0.0.1:2001` through `useEveAgent({ host })`. If the bundled Node.js is missing, the port is in use, or the bundle has no built agent, Chat shows the reason from the `chat.agent` bridge command. Chat waits for both that command and the health check, so another program answering on port 2001 cannot make Chat ready.

While the app lock is on, the packaged agent does not start until you unlock Sage. With encryption on, Sage also passes a world key through the same pipe, so eve’s session files are encrypted on disk. [Encryption at rest](../security/encryption.md#chat-workflow-files) covers that key.
