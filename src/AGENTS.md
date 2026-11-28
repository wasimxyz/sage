# Zig core

Read `docs/architecture.md` first, then the docs page for the feature you are changing. The lock, the vault, the Keychain mirror, and the agent server are covered in `docs/security/`.

## Toolchain

- Sage pins Native SDK 0.11.0 in `.native-sdk-version` and Zig 0.16. It has a Zig core and an ejected `build.zig`, so never run `native eject`.
- The `native-sdk` skill and native-sdk.dev describe newer releases, where apps have TypeScript cores. For the pinned SDK, read the CLI's own guides: `native skills get zig`, `native skills get core --full` (bridge, web view, security, packaging), and `native skills get automation`.
- Build with `make build`. A bare `native build` builds ReleaseFast, and `-Dautomation=true` overwrites `zig-out/bin/Sage`.

## Bridge commands

A new command changes all of these together:

- `bridge.commands` in `app.json` and `command_names` in `src/main.zig`, in the same order. A test checks the order.
- A handler in `handlers` or `async_handlers`, and `async_handler_count` for an async one.
- `requireUnlocked` in the handler, unless the command must answer while Sage is locked. Check that the list in `docs/security/lock.md` still holds.
- A typed wrapper in `frontend/src/bridge.ts`.
- The "Bridge commands" section of the feature's docs page.
- `allowedBridgeCommands` in `agent/scripts/screenshots.ts`, if the screenshots call it.

A removed command gets a test that says it is gone.

## Rules

- Only the window event-loop thread touches SQLite. That thread never loads the speech library.
- Each `db.exec` runs as its own transaction, up to `relational_store.max_exec_statements` statements. The Native SDK denies `BEGIN`, savepoints, `ATTACH`, and TEMP tables.
- A new Zig file joins the `test {}` block in `src/main.zig`. A file built as its own module needs its own `b.addTest` in `build.zig`, or its tests never run.
- The app tests run in several processes at once, one per CPU up to 8. `src/test_runner.zig` gives each process every nth test from `SAGE_TEST_SHARD`. Pass `-Dtest-shards=1` to `native test`, or `NATIVE_TEST_FLAGS=-Dtest-shards=1` to `make test-zig`, for one process.
- Because other tests run at the same time, a test never uses a fixed Keychain name, port, or path. The test rig takes its app id, which names its Keychain item, from `testRigAppId`.
- `src/test_runner.zig` is a copy of Zig 0.16's default test runner. Copy it again when you bump Zig.
- Memory (Facts and Events) is off in release builds. When you touch journal, Dream, chat, or memory code, also run `SAGE_MEMORY=true make test`.
- Automation-only commands and env vars sit behind `build_options.automation`, with a test that a shipping build ignores them.
- Background work stops when Sage locks. Every child process stops on quit, Ctrl-C, and crash, and frees its port.
- Window code must not assume Sage is the active app. After an inactive launch, `keyWindow` is nil.
- The frontend copies some Zig values. When you change one, also change `frontend/src/lib/lock-errors.ts`, `recovery-key.ts`, `idle-timeout.ts`, `onboarding.ts`, or `frontend/src/components/setup/use-setup-models.ts`.
- `agent/agent/instructions.md` is compiled into the app, which shows it in Settings.
- `security-tests/` greps `eve_sidecar.zig`, `main.zig`, the `ollama*.zig` files, `dictation.zig`, `export.zig`, and `display_awake.zig`. Run them after you edit those files.
- Before you change `speech_apple.zig`, read `src/speech/AGENTS.md`. Before you add a migration, read `src/schema/AGENTS.md`.

## Ollama

`src/ollama_server.zig` starts, restarts, and stops the pinned server, whose version and SHA-256 values live in `scripts/fetch-ollama.sh`. A Sage inside an app bundle never reads `SAGE_OLLAMA_PATH`. The server gets an allowlisted environment, and Sage skips models with `remote_host` or `remote_model`.

## Running the app

- View > Toggle Web Inspector does nothing on macOS. Use Safari's Develop menu.
- Agents can't click, focus the window, or answer Touch ID in the native app. Ask the user.

## Docs

- Ollama: https://docs.ollama.com/llms.txt. Fetch it on any Ollama change. `src/ollama.zig` calls `/api/generate`, `/api/embed`, `/api/tags`, `/api/ps`, `/api/pull`, and `/api/delete`.
- Native SDK: https://native-sdk.dev/llms.txt. It describes the newest release, not 0.11.0.

## Skills

- `native-sdk` (vercel-labs/native): what the Native SDK is, `app.json`, bridge commands, and packaging. Then read the CLI guides above.
