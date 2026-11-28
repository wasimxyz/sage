# Chat agent

The eve 1.5 app behind Chat. Read `docs/agent/README.md`, then `docs/agent/eve-app.md`. Routes and the token are covered in `docs/security/agent-server.md`.

## Versions

- eve changes fast. Read `agent/node_modules/eve/docs/` and `agent/node_modules/ai/docs/`, which match the installed versions, before eve.dev or ai-sdk.dev.
- This package uses TypeScript 7, the native compiler. The other packages use 5.9, so don't copy `tsconfig.json` options between them.

## Rules

- Sage has no eve sandbox. Keep `defaultTools: false` and `eve build --skip-sandbox-prewarm`. A tool that needs bash, files, skills, subagents, or attachments needs a sandbox again, so raise it with the user first.
- A tool's name is its file name in `agent/agent/tools/`. A rename also changes `agent/evals/lib/tool-names.ts`, `frontend/src/lib/chat/tool-part.ts`, the tool cards in `frontend/src/components/chat/`, `agent/agent/instructions.md`, and the docs.
- eve runs each `defineDynamic` before every model call. Keep its work in `ctx.memo`.
- `OLLAMA_BASE_URL` must be a loopback address with the `/api` prefix. The dev default is `http://127.0.0.1:11436/api`, read from `agent/.env.local`. Packaged Chat ignores `.env.local` and gets its address from `src/eve_sidecar.zig`.
- Every route needs the agent token except `/eve/v1/health`, and that includes `/.well-known/workflow/`.
- `scripts/copy-agent-into-app.sh` greps `agent/agent/channels/eve.ts` for `origin: "zero://app"` and `allowHeaders: "*"`. Keep both literals, or `make package` refuses the build.
- Every session's title stays "Sage chat". Never put journal or chat text in an eve field that survives retention.
- Nothing under `agent/agent/` may refer to eval code or the AI Gateway. A security test checks this.
- Tests for `agent/agent/lib/*` go in `agent/scripts/*.test.ts`. A test inside `agent/agent/` never runs.
- `make package` installs this package with `--omit=dev`, so a runtime import must be a dependency. The packaged bundle refuses `typescript`, `@types`, `@biomejs`, `ultracite`, and `@vercel/blob`.
- After `ultracite fix`, run the tests that hold the regexes it changed.
- When you edit `agent/agent/instructions.md` or an eval rubric: Chat listens first, offers an exercise only when asked, doesn't feed worry loops, and is not "an AI therapist".

## Upgrading eve

- `eve`, `ai`, and `@ai-sdk/provider-utils` move together in `agent/package.json` and `frontend/package.json`, overrides included.
- `agent/packages/world-encrypted-local/package.json` pins `@workflow/world` and `@workflow/world-local` exactly, to the versions in `agent/package.json`. npm doesn't apply overrides to a `file:` package.
- Search for renamed eve APIs everywhere, including shell scripts and `security-tests/`.
- Before you drop the v26 event reader or the converter, check that no saved chat still has `event_format` 26.

## Docs

- Ollama: https://docs.ollama.com/llms.txt. Chat calls `/api/chat` through `ollama-ai-provider-v2` (https://github.com/nordwestt/ollama-ai-provider-v2).
- eve: https://eve.dev/llms.txt, which may be ahead of the installed version.

## Skills

- `eve` (vercel/eve): the agent, tools, channels, and evals.
- `ai-sdk` (vercel/ai): `streamText`, tools, and providers. A copy ships in `agent/node_modules/ai/skills/`.
