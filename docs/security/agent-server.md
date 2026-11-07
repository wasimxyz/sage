# Local agent server

Sage’s Chat tools need to read journal entries and past chats, but the eve agent is a separate Node.js process that cannot open the SQLite file itself. Sage runs a small HTTP server inside the app so those tools can ask for a search, one entry, or part of a chat. This page covers how that server and the Chat port check who is calling, and [The eve app](../agent/eve-app.md) covers the agent.

The server only answers read requests. It never writes entries or chats.

## The socket

The server listens on a Unix socket under `/tmp`, with no TCP port, so other machines cannot reach it. Sage names the socket from a hash of the app data directory, so each copy of Sage gets its own short path. Sage sets the socket mode to `0600` after binding, and deletes any leftover socket file on launch and on quit.

## The token

At launch, Sage creates a random 32-byte token. Every request must send `Authorization: Bearer <token>`, and a missing or wrong token returns `401`. Sage hashes both tokens before comparing them, so a missing, short, or wrong token takes the same time and gets the same answer.

How the agent gets the token depends on how it started:

- **Packaged app**: Sage starts the agent and writes the token into a pipe the agent reads once at start, with the world key when encryption is on. On each connection, the server asks macOS for the caller’s process id and closes the connection unless it is the agent Sage started.
- **`make dev` and `make eval`**: the agent starts on its own, so Sage writes `{ "socket", "token" }` to `agent-server.json` with mode `0600`. The file is in `~/Library/Application Support/com.wasimxyz.sage-dev/` for dev builds, and in the throwaway `SAGE_DATA_DIR` for evals.

`agent-server.json` is how Sage and a separately started agent find each other, and a packaged app never writes it. Any process running as you can read it and call the server, but other user accounts cannot. Sage deletes the file on quit, and a missing file tells the agent tools that Sage is not running.

## Routes

`GET /features` reports whether this build has memory on. In a build with memory off, the memory routes return `404`.

- `GET /health`: confirms the server is up. It still needs the token.
- `GET /features`: reports whether this build has memory on
- `POST /journal/search`: searches entry summaries by meaning. The body is `{ "query", "limit" }`, and an optional `embedding` array skips Ollama and ranks with that vector. Summaries that score under 0.45 are left out. The answer adds `matched`, `belowCutoff`, and `unreadable`: the matches kept before `limit`, the summaries under the cutoff, and the summaries whose vector can’t be compared with the query’s. A `query` that isn’t text, or is too long, is a 400.
  - `from` and `to` (`YYYY-MM-DD`, both or neither) keep the search to entries dated in that span. Both must be real days, and `from` can’t be after `to`, or the route returns 400. The answer also gives `total` and `unsummarized`, plus `nearest` when no entry falls in the span.
  - With `from` and `to` and no `query`, the route lists the entries in the span without ranking them or calling Ollama. It picks up to `limit` entries evenly from the entries in the span, oldest first, so a stretch with many entries gets more of them. It adds `total`, plus `nearest` when no entry falls in the span. An entry with no summary shows the start of its body.
- `GET /journal/entry/{id}`: one decrypted entry
- `POST /chats/search`: searches chat messages by meaning. The body is `{ "query", "limit" }`, with the same optional `embedding` as journal search. Messages that score under 0.45 are left out, and each chat shows at most 2. The answer adds `matched`, `belowCutoff`, and `unreadable`, as journal search does, plus `unindexed`: chats with messages that have no embedding yet.
  - `from` and `to` are ISO UTC times such as `2026-10-19T07:00:00.000Z`, both or neither, with `from` before `to`. They keep the search to messages saved from `from` up to, but not including, `to`. A message saved before Sage kept that time counts when its chat’s `created_at` is before `to` and its `unstamped_until` is not before `from`. `unstamped_until` is the last moment such a message could have been saved, so a chat that started before Sage kept the time and went on later does not match the months between. A chat with no `unstamped_until` uses its `updated_at`.
  - `exclude` is a chat id to leave out, such as the one being answered.
  - With `from` and `to` and no `query`, the route lists the chats active in that time without calling Ollama. It picks up to `limit` chats evenly, oldest first, and adds `total`. Each chat has its summary, or the start of its first User message.
  - A bad time, an `exclude` that isn’t an id, or a `query` that isn’t text is a 400.
- `GET /chats/{id}`: part of one decrypted chat: its title, times, and summary, and its last 5 User and Sage messages. `?message={seq}` returns that message and up to 2 on each side instead. An unknown chat is a 404 with `{ "error": "not_found" }`. A `message` that is not a User or Sage message of the chat is a 404 with `{ "error": "message_not_found" }`, so the agent can tell the two apart. Message numbers are event positions and have gaps, so only a number Sage has shown is sure to work.
- `GET /agent/instructions`: the extra Chat instructions saved in Settings > Agent, as `{ "user" }`. Missing text is an empty string.
- `GET /memory/profile`: the newest profile facts, up to 50. Each fact includes `sourceType` and `sourceId`.
- `POST /memory/facts/search`: ranked search over facts, with the same body as journal search. Each result includes `sourceType` and `sourceId`.
- `POST /memory/events/search`: ranked search over dated events, with the same body as journal search. Each result includes `sourceType` and `sourceId`.

While Sage is locked, the search, fetch, chat, memory, and instruction routes return `409` with `{ "error": "locked" }`. The agent then asks you to unlock Sage.

## Limits and threads

The listener runs on its own background thread, not the window loop. It passes each connection to its own task and goes back to accepting, so a client that stops halfway through a request cannot hold up the others.

Each read waits at most two seconds for the rest of the request, and an unfinished request then gets `408` and the socket closes. At most 16 connections are served at once. Past that, Sage answers `503` and closes.

Database work runs on the app’s loop thread, the same rule as the bridge. When a search body has no `embedding`, Sage embeds the query on a worker thread with the usual Ollama watchdog.

## The Chat port

The same token guards the Chat server: `127.0.0.1:2001` in a packaged app, and port 2000 in `make dev`. Session routes need `Authorization: Bearer <token>`, and a missing or wrong token returns 401. `GET /eve/v1/health` stays public and reports only that the agent is up.

Because health is public, a healthy answer does not prove the process on port 2001 is Sage’s agent. Only the `chat.agent` bridge command knows whether Sage started that server, so Chat checks both.

Each Chat caller gets the token its own way:

- **The Chat screen** reads it through `chat.agentToken`, which refuses while Sage is locked. Deleting a chat sends the same token when Sage cancels the turn.
- **The agent in `make dev` and `make eval`** reads `token` from `agent-server.json` on each check. Until that file exists, requests return 401.
- **The `eve dev` terminal** gets it from `agent/scripts/dev-auth-hook.ts`, which the `dev` script loads ahead of eve. On each loopback `/eve/v1/…` request, the hook reads the token from `agent-server.json` and replaces the bearer eve built. It leaves Ollama and other non-loopback requests alone.
- **The `make eval` client** gets the token through `EVE_EVAL_AUTH_TOKEN`, as [Eval suite](../agent/evals.md#the-eval-server-and-its-token) explains.

The hook reads the file on every request because Sage writes it after the `eve dev` terminal is already up. The terminal’s first `/eve/v1/info` request fails with 401 and the prompt still opens, and later requests carry the token. Health stays public, so `make dev` can wait on it before Sage starts.

## The workflow routes

eve also serves its job runner and webhook routes under `/.well-known/workflow/` on the Chat port, and the Chat channel’s token check never sees them. `agent/agent/lib/workflow-guard.ts` puts the same token in front of that whole prefix:

- It checks every way Node.js passes a request to the server: plain requests, `Expect` requests, and upgrades.
- A missing or wrong token returns 401, and so does any request before Sage has written a token.
- Node.js loads it through `workflow-guard-preload.ts` before the server starts. A packaged app uses `--import`, and `eve dev` and the eval server use `NODE_OPTIONS`.

If the guard file is missing, a packaged Sage does not start Chat. Sage never runs `eve start`. If you run `eve start` by hand, it loads no guard, so its workflow routes answer without a token.

The runner posts each job back to its own flow route, so the guard also adds the token to those calls. It adds it only for the port the runner posts to, read from `WORKFLOW_LOCAL_BASE_URL` or `PORT`, so a loopback call to any other port goes out without it. The guard cannot add the token to jobs that skip `fetch`, so it refuses to start while `WORKFLOW_NODE_HTTP` is on.

## Session files

eve keeps its own session files outside SQLite. [Chat storage](../agent/storage.md#eves-session-files) covers where they live, and [Encryption at rest](encryption.md#chat-workflow-files) covers how they are encrypted.
