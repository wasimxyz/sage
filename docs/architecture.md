# Architecture

This page explains how the parts of Sage fit together: the Zig core, the web view frontend, the bridge between them, the SQLite file, Ollama, and the eve agent. Read it before the feature pages listed in the [docs index](README.md).

## The app process

Sage is one Zig program. Its entry point is `src/main.zig`, which owns a native window through the Native SDK and runs an event loop. The window shows a React app in the system web view:

- Packaged builds load `frontend/dist` from the `zero://app` origin.
- Dev builds load the Vite server at `http://127.0.0.1:5173`.

A packaged build does not let the Vite origin load in the window or call the bridge.

## The bridge

The frontend reaches the Zig core through bridge commands. The frontend calls `window.zero.invoke(command, payload)`, and `src/main.zig` passes each call to its handler. Every command is declared twice: `app.json` lists the command and the origins that may call it, and `src/main.zig` registers the handler.

Large values travel in 32 KiB chunks. The frontend sends one chunk at a time with its byte offset, and the core joins them. Journal entries and imported files read back in slices the same way, while chat transcripts read back by event index, as [Chat storage](agent/storage.md) explains.

Each feature page lists its own commands: [The journal](journal.md), [Dream](dream.md), [Models](models.md), [First-launch setup](onboarding.md), [Chat storage](agent/storage.md), and [Memories](agent/memories.md).

## Storage

Journal entries, chats, and memories live in one SQLite file named `app.db`. The Native SDK RelationalStore opens it in the app data directory:

- Development: `~/Library/Application Support/com.wasimxyz.sage-dev`
- Packaged builds: `~/Library/Application Support/com.wasimxyz.sage`
- Either build: the folder in `SAGE_DATA_DIR` when that variable is set

SQLite may also write `app.db-wal` and `app.db-shm` next to it. Migrations are append-only files under `src/schema/`. `src/journal.zig` owns every read and write through its `Store` type.

The data directory also holds three things that are not the journal:

- `agent-server.json`: the socket path and token, written only in `make dev` and `make eval` and deleted on quit
- `eve/`: the packaged Chat working directory, including session files under `.eve/.workflow-data`
- `ollama/`: `serve.log`, the output of Sage’s Ollama server, replaced at each start, and `serve.pid`, the process id of the running server

Sage does not open a second SQLite file. The Native SDK stores window size and position in `windows.zon` in its own state directory. `src/lock.zig`, `src/vault.zig`, and `src/keychain.zig` protect `app.db`, and [Security at a glance](security/README.md) covers them.

## Threads

Only the event loop thread touches SQLite. Work that waits on the network runs on worker threads. Each worker puts its result on a queue and wakes the loop thread, which writes the result.

Four queues exist: embeddings, Dream jobs, lock jobs, and agent server jobs.

The agent server listens on its own background thread and gives each connection its own task, so one slow client cannot hold up the rest. Each request becomes a job on the agent server queue, and the loop thread does the database work and writes the reply. [Local agent server](security/agent-server.md) covers its limits and timeouts.

## Ollama

Ollama is the local model server that runs the models. Sage ships a pinned copy, starts it at launch, and stops it on quit. The mode follows where the executable sits, the way Chat and Node are found. A Sage inside an app bundle runs its own copy on `127.0.0.1:11435`. Every other launch, such as `make dev` and `make eval`, runs the copy named by `SAGE_OLLAMA_PATH` on `127.0.0.1:11436`, so a packaged and a dev Sage can run at once. Sage does not use port 11434, where an Ollama you run yourself listens. Sage uses it for these jobs:

- **Embeddings**: `nomic-embed-text` turns entries, chat messages, summaries, and memories into vectors, so Chat can find them by meaning. Any pulled tag works, and `SAGE_EMBED_MODEL` changes the name Sage looks for.
- **Dream**: the summary model writes entry and chat summaries and chat titles, and in a memory build it extracts memories. The default is `qwen3.5:9b`, and `SAGE_SUMMARY_MODEL` changes it.
- **Chat**: the eve agent calls the chat model you pick. The Chat screen lists pulled chat models through `ollama.models`.
- **Model management**: Settings > Models downloads and deletes models, as [Models](models.md) explains.

Every Ollama call follows the same rules:

- Chat and Dream call the native `/api` routes: `POST /api/chat`, `POST /api/generate`, and `POST /api/embed`.
- Sage skips any model Ollama marks as cloud-hosted (`remote_host` or `remote_model` in `/api/tags`), so every model runs on this Mac.
- Each call runs on a worker thread with a watchdog that closes the socket if the call runs past its timeout.

The client is `src/ollama.zig`, the server process is `src/ollama_server.zig`, and Dream is in `src/dream.zig`. [Dream](dream.md) covers what each Dream step sends.

### The bundled server

Sage starts the server at launch, before you unlock, and stops it on quit. Locking does not stop it, but it unloads the models, as [The app lock](security/lock.md#local-ai-and-the-lock) explains. Its details are:

- **Binary**: `Contents/Resources/ollama/ollama` in the app, with its libraries beside it. An app bundle ignores `SAGE_OLLAMA_PATH`. Any other launch runs the copy that variable names, which `make dev`, `make seed-dev`, and `make eval` set to the pinned build in `third_party/ollama/`. With no copy, Sage shows “Sage’s local AI files are missing. Reinstall Sage.”
- **Restart**: when the server exits, the next status check (`embeddings.status`, or `ollama.setupStatus` during setup) or start brings it back, at most once every 10s. The status checks run only while Sage is unlocked.
- **Leftover servers**: `ollama/serve.pid` names a server that a crashed Sage left running. Sage stops that server only when its executable is the same binary, then starts its own. If another app holds the port, Sage shows “Port 11435 is in use by another app.”
- **Environment**: the server starts with the same allowlist as Chat (`HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, and `TZ`), plus `PATH=/usr/bin:/bin`, `OLLAMA_HOST=127.0.0.1:<port>`, `OLLAMA_NO_CLOUD=1`, and `OLLAMA_NOPRUNE=1`. It gets `OLLAMA_MODELS` only when Sage's own environment sets it. No other `OLLAMA_*` setting reaches it.
- **Log**: `ollama/serve.log` in the data folder. Sage empties it at each start and cuts it back once it passes about 1 MB, so the cap is approximate. The last line appears in the “did not start in time” and “port in use” errors.

### Models folder and `~/.ollama`

The server uses Ollama’s default model folder, `~/.ollama/models`. Any Ollama you run yourself shares that folder, so a model pulled in either one shows up in both. Delete in Settings > Models removes the model for every app that uses it. `OLLAMA_NOPRUNE=1` stops the server from cleaning up unused model files at startup, so it cannot delete a download that another server is still writing.

The rest of `~/.ollama` is shared too, including Ollama’s keys and `server.json`. If you moved your models with the Ollama app’s own setting, Sage’s server may not find them unless `OLLAMA_MODELS` is set. Sage has not tested that case.

A loaded model can keep the last prompt in memory until it unloads, about five minutes by default. The Ollama Mac app, when you run it, writes its log to `~/.ollama/logs/server.log`. Sage’s server writes to `serve.log` instead.

Ollama does not save Sage’s prompts as chats. Sage never writes to the Ollama Mac app’s own chat database.

## The eve agent

Chat adds a second process: an eve agent, a Node.js program in `agent/`. During `make dev` it runs as `eve dev` on port 2000. A packaged app starts the built Chat server on `127.0.0.1:2001` with the Node.js bundled inside the app.

The agent calls the chat model through Ollama’s `/api/chat` and reads the journal through the local agent server in `src/agent_server.zig`. [Chat at a glance](agent/README.md) covers the feature, and [Local agent server](security/agent-server.md) covers how the server checks callers.

## Building

`make build` and `make dev` run this repo’s ejected `build.zig` through the Native SDK CLI. The build finds the CLI from `NATIVE_SDK_PATH` or `npm root -g`, and `-Dnative-sdk-path=...` overrides both. CI installs the version pinned in `.native-sdk-version`.

The first build downloads Zig 0.16 if it is not already on `PATH`. To call Zig directly, put the downloaded copy on `PATH` first:

```sh
export PATH="$HOME/.native/toolchains/zig-0.16.0:$PATH"
```

`scripts/fetch-ollama.sh` downloads the pinned Ollama archive, checks its SHA-256, and keeps an extracted copy in `third_party/ollama/`. `make dev`, `make seed-dev`, and `make eval` use that copy. `make package` copies it into the app. [Scripts](../scripts/README.md#packaging) has the steps.
