# Sage

Sage is a private journal for macOS with a built-in AI agent. Your entries, chats, and the agent’s memories stay on your Mac, and you can encrypt all of them.

## What Sage does

- **Journal**: write entries in a Markdown editor. Import Markdown files from apps such as Notion, and export entries as Markdown.
- **Chat**: ask an agent about your journal. It runs local models through Ollama, and you pick the model, context length, and Thinking for each conversation.
- **Search**: local embeddings let Chat find entries by meaning, not only by matching words.
- **Dream**: a job you start from the sidebar. It summarizes entries and titles chats, and in a memory build it also extracts memories.
- **Memories**: an opt-in build feature that keeps facts about you and dated events. It is off by default.
- **Lock and encryption**: lock Sage with a password or Touch ID, and encrypt entries, chats, and memories inside the database file.

Sage is a native desktop app built with the Vercel Native SDK and eve.

## Requirements

- macOS
- Node.js 24, for `make setup` and `make dev`
- Native SDK CLI: `npm install -g @native-sdk/cli@0.10.1`
- Ollama with a chat model and the embedding model: `ollama pull qwen3.5:9b` and `ollama pull nomic-embed-text`

The pinned CLI version is in `.native-sdk-version`, and CI installs exactly that version. Keep the two in step when you upgrade. The first build downloads Zig 0.16 if it is not already installed.

## Getting started

1. Install dependencies: `make setup`
2. Start the app and the Chat agent: `make dev`

`make dev` starts the Chat agent on port 2000, then opens the app window. If the agent is already running, Sage leaves it alone. Stopping `make dev` stops only the agent it started.

Memory is off by default. To build with memory on, add `SAGE_MEMORY=true` in front of `make dev`, `make build`, or `make package`. [Memories](docs/agent/memories.md) explains the feature.

A packaged app starts the agent itself on port 2001, using the Node.js bundled inside the app. If the agent cannot start, the Chat screen says why, and the journal still works.

## Commands

| Command | What it does |
| --- | --- |
| `make setup` | Install frontend, agent, and eval-viewer dependencies |
| `make dev` | Start the Chat agent and the app window for development |
| `make build` | Build the frontend and the release binary in `zig-out/bin/` |
| `make check` | Check the pinned CLI version, `app.json`, and the frontend lint and types |
| `make test` | Run the Zig, frontend, agent, eval-viewer, and security tests |
| `make precommit` | Run `make check`, `make test`, and `make package` |
| `make eval` | Seed a throwaway journal, run Dream, and grade with eve eval |
| `make eval ARGS='--tag example'` | Run only the Sam format-template cases |
| `make eval-upload` | Upload saved eval reports to Vercel Blob (asks first) |
| `make eval-viewer-dev` | Start the eval report viewer in development |
| `make eval-viewer-build` | Build the eval report viewer for production |
| `make eval-viewer-start` | Serve the production eval report viewer (run `make eval-viewer-build` first) |
| `make package` | Build a Mac `.app` bundle with the Chat agent and Node.js inside. The first run downloads Node.js into `third_party/node/` and reuses it after that. |
| `make package-archive` | Package the `.app` and build a `.dmg` from it |

## Project structure

The app is a Zig core built on the Vercel Native SDK, a React frontend, and a Node.js agent. Data lives in SQLite, and local models run through Ollama.

- `src/`: the Zig core that owns the window and the database. `src/journal.zig` has the SQLite commands.
- `frontend/`: the React app with the TipTap editor, built with Vite
- `agent/`: the eve agent behind Chat, a Node.js program that talks to Ollama
- `eval-viewer/`: the Next.js app that lists eval reports from Vercel Blob
- `scripts/`: shell scripts that package the app and run evals
- `security-tests/`: tests for the token, origin, and packaging rules, run by `make test`
- `docs/`: how Sage works
- `app.json`: app identity, window size, and bridge allowlists

## Documentation

Start with [Architecture](docs/architecture.md). The [docs index](docs/README.md) lists every page.
