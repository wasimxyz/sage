# AGENTS.md

Sage is a local-only macOS journal: a Zig core (`src/`), a React frontend (`frontend/`), and an eve Chat agent (`agent/`). Developer docs start at `docs/README.md`.

## Folder files

These folders have their own `AGENTS.md`: `src/`, `src/schema/`, `src/speech/`, `frontend/`, `agent/`, `agent/evals/`, `eval-viewer/`, `scripts/`, `security-tests/`, `docs/`, and `.github/`. Before you edit a file, read every `AGENTS.md` from the root down to its folder. Some agents load only the root file on their own.

Don't add a `CLAUDE.md`. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists.

## Private data

- Journal entries, chats, and memories stay on this Mac. Don't add a cloud model fallback, and never offer Ollama cloud models.
- Never write journal or chat text to a log, or to a field that stays readable when encryption is on.
- Dev, eval, and automation runs set a scratch `SAGE_DATA_DIR`. A packaged build without it opens the real journal and its Keychain item.
- The eval suite may send the made-up cases in the eval content (`agent/evals/content/`, a checkout of the private sage-evals repo) to the cloud judge and simulated user. Never send real journal entries, chats, or memories to a cloud model, and never point `SAGE_EVAL_CONTENT` at them.
- People have used Sage since v0.1.0, so a change must not lose their data. Migrate old rows forward.

## Ollama

Sage runs its own pinned Ollama: on `127.0.0.1:11435` inside an app bundle, and on `127.0.0.1:11436` for `make dev`, `make eval`, and `make seed-dev`. It never uses `127.0.0.1:11434`, where an Ollama you run yourself listens. Chat and Dream call the native `/api` prefix. Don't switch them to `/v1`.

## Checks and tests

- `make check` checks the Native SDK CLI and release versions, then runs `native check` and the lint and type checks for `frontend/`, `agent/`, and `eval-viewer/`.
- `make test` runs the Zig tests, each package's tests, the script tests, and `security-tests/`.
- Run both before you commit and push, and fix failures before you finish. Docs-only changes skip `make test`. If a target can't run, say which one.
- `sh: ultracite: command not found` means `make package` installed the agent without its dev packages. Run `npm --prefix agent install`.
- Never run `make eval`, the eval runner, a dry run, or a sweep, and never ask a subagent to. Only the user runs evals.

## Before you push

- Reread every comment and docs line you changed, and check it against the code. Docs quote UI copy word for word, so a copy change is also a docs change.
- After you rename or move something, search for the old name in the `Makefile`, `scripts/`, `security-tests/`, and `docs/`. Several checks grep source text.

## macOS

- `sed -i` is BSD `sed` here, so edit files with your edit tool. There is no `timeout` command.
- Zig isn't on `PATH`. Use the make targets or `native`. The `native` CLI is installed per nvm Node version, so install the version in `.native-sdk-version` for the Node you use.
- "Port 5173 is already in use" means a `make dev` is already running. Don't kill it.
- Never kill processes by name or pattern. Signal only process ids you started.

## Releases

Push a version tag only when the user asks, and only after `main`'s CI passes on the merge commit. `docs/release.md` has the steps.

## Skills

- When an `AGENTS.md` names a skill, use it if it is installed. Otherwise load it for the session with `npx skills use <source>@<skill>`, or with `npx skills use <pinned URL>` when the file gives one.
- Ask before you install a skill that no `AGENTS.md` names, and never pass `-y`.
- When a skill's advice conflicts with an `AGENTS.md` rule, follow the `AGENTS.md`.
- `ultracite` (haydenbleasel/ultracite): fixing lint and format errors in `frontend/`, `agent/`, and `eval-viewer/`.

## Voice

Docs and UI copy match the voice in `docs/`: short sentences, existing names, no new jargon. UI copy says "local AI"; code keeps the `ollama.*` names.
