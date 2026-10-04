# Sage

Sage is a local-only macOS journal with a Zig core, a React frontend, and an eve Chat agent. Read `docs/README.md` before changing behavior.

## Skills

Read the matching skill before editing that tree. If it is not installed, install it with `npx skills add` ([CLI](https://www.skills.sh/docs/cli)), then read it:

```
npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices
```

| Area | Skill | Repo fallback |
| --- | --- | --- |
| `src/`, `app.json`, packaging, Native SDK automation | [`native-sdk`](https://skills.sh/vercel-labs/native/native-sdk) (then `native skills get zig`; `native skills get automation` when driving a running app) | `docs/architecture.md`, `docs/security/` |
| `agent/` eve app, tools, channels, memory, world | [`eve`](https://skills.sh/vercel/eve/eve) | `agent/node_modules/eve/docs/`, `docs/agent/eve-app.md` |
| `agent/` AI SDK / Ollama provider | [`ai-sdk`](https://skills.sh/vercel/ai/ai-sdk) and the Ollama docs below | `docs/agent/eve-app.md` |
| TipTap editor | [`tiptap`](https://skills.sh/ueberdosis/tiptap/tiptap) | `frontend/src/components/editor.tsx` |
| `frontend/` or `eval-viewer/` UI | [`shadcn`](https://skills.sh/shadcn/ui/shadcn), [`vercel-react-best-practices`](https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices) | existing components |
| JS/TS lint and format | [`ultracite`](https://skills.sh/haydenbleasel/ultracite/ultracite) | `frontend/biome.jsonc`, `agent/biome.jsonc`, `eval-viewer/biome.jsonc` |
| `eval-viewer/` Next.js | [`next-best-practices`](https://skills.sh/vercel-labs/openreview/next-best-practices); [`next-dev-loop`](https://skills.sh/vercel/next.js/next-dev-loop) after a user-visible change | `eval-viewer/` |
| `docs/` | [`writing-guidelines`](https://skills.sh/vercel-labs/agent-skills/writing-guidelines) | match existing `docs/` voice |
| UI review | [`web-design-guidelines`](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) | only when asked |

## Ollama

Sage calls Ollama at `127.0.0.1:11434` on the native `/api` prefix. Do not switch Chat or Dream to `/v1`.

On any Ollama question or change, fetch the current docs. Start at [llms.txt](https://docs.ollama.com/llms.txt), then open the page that matches the work:

- [API intro](https://docs.ollama.com/api/introduction)
- [Chat](https://docs.ollama.com/api/chat) (`POST /api/chat`)
- [Generate](https://docs.ollama.com/api/generate) (`POST /api/generate`, Dream summaries)
- [Embed](https://docs.ollama.com/api/embed) (`POST /api/embed`) and [Embeddings](https://docs.ollama.com/capabilities/embeddings)
- [List models](https://docs.ollama.com/api/tags) (`GET /api/tags`)
- [Pull](https://docs.ollama.com/api/pull) / [Delete](https://docs.ollama.com/api/delete)
- [Thinking](https://docs.ollama.com/capabilities/thinking) and [Context length](https://docs.ollama.com/context-length)
- [Tool calling](https://docs.ollama.com/capabilities/tool-calling)
- [Errors](https://docs.ollama.com/api/errors) and [Streaming](https://docs.ollama.com/api/streaming)
- [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (not our path)

Zig client: `src/ollama.zig`. Node Chat path: `ollama-ai-provider-v2` in `agent/`.

## Checks and tests

Before committing and pushing, run `make check` and `make test` and fix failures before you finish. Docs-only changes skip `make test`. If a target cannot run, say so.

`make check` runs the lint and type checks for `frontend/`, `agent/`, and `eval-viewer/`.

Do not run `make eval` unless asked.

## Constraints

- Journal entries, chats, and memories stay on this machine. Do not add a cloud model fallback.
- Only the window event-loop thread touches SQLite.
- New bridge commands go in both `app.json` and `src/main.zig`.
- Files under `src/schema/` are append-only.
- Docs and UI copy should match the voice in `docs/`: short sentences, existing names, no new jargon.
