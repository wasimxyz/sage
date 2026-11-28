# Testing the lock and encryption

This page explains how the lock and encryption are tested: the unit suite, the security tests, and the automation server that drives a running app. Read it before you write a smoke test.

## What `make test` runs

`make test` runs every suite that needs no Ollama:

- The Zig tests, against an in-memory SQLite database with no window
- The frontend unit tests in `frontend/src/lib/`
- The agent tests: eval fixtures, the eval runner in `agent/scripts/eval/` (including the order it loads settings in), scripts such as the dev auth hook, and the encrypted session storage in `agent/packages/world-encrypted-local`
- The eval viewer unit tests in `eval-viewer/lib/reports/`
- The security tests in `security-tests/`

`make check` validates `app.json`, checks the pinned Native SDK CLI version, and runs the lint and type checks for the frontend, the agent, and the eval viewer.

## The Zig suite

The Zig tests cover:

- Wrapping and unwrapping the data key
- The recovery slot: encrypting with no password, a wrong or malformed key, both slots opening the same data key, and a password wrap pasted into the recovery rows
- Recovery key generation, grouping, and forgiving input (case, dashes, spaces, O for 0, I or L for 1)
- Wrong passwords, tampered ciphertext, and ciphertext moved between fields
- Passwords shorter than the minimum, and an older short password that still unlocks
- Wrong guesses: five free, then a five-second wait that survives a relaunch and never grows
- Re-wrapping on password change, and the file rebuild that takes the old wrapped key out of `app.db` and its write-ahead log
- Removing the password: its proof, the Touch ID and recovery key requirements, and the file rebuild that takes the old password wrap out of `app.db`
- A first password on an encrypted journal needing a fresh prompt, and a recovered session setting a password without the old one
- The recovery key sharing the password’s wrong-guess count and wait
- A refused password removal leaving the Keychain alone
- A journal in `SAGE_DATA_DIR` keeping its Touch ID key under a Keychain service of its own
- A recovered session ending when the session locks or the lock turns off
- Each Touch ID prompt that gates a change (a first password, removing encryption, a new recovery key): a failed prompt changes nothing, and a good one finishes the change on the loop thread
- A relaunch that unlocks with the recovery key and keeps asking for a new one across quits
- Replacing the recovery key, with the old one then refused, and the rotate flag staying cleared across a relaunch
- Refusals while locked or while a rewrite or file rebuild is still pending
- An export writing only to the folder the export picker returned, once, with journal entries and conversations in separate subfolders
- A simulated relaunch: lock, unlock, search, save, delete, and disable
- Retries of a failed enable, including a crash mid-rewrite that must wait for unlock
- A file rebuild that fails, then succeeds on retry, and is not repeated on the next launch
- A password change whose rebuild fails: the reply stays ok, `enc.scrub_pending` stays set, and the securing screen retries
- The status commands that refuse while locked, with and without encryption
- The Chat token command refusing while locked
- The packaged Chat server waiting for unlock whenever the lock is on
- Session locking clearing the journal key and world key, then restoring access after unlock
- Idle timeout defaults, supported values, persistence, and behavior for Never, before the timeout, and at the timeout
- HKDF derivation of the eve world key, and wiping `.eve/.workflow-data`
- The bundled Ollama server: finding the binary from the app path or `SAGE_OLLAMA_PATH`, its child environment, the leftover-server check, the last log line, and the 10s restart wait
- The Ollama ports (11435 inside an app bundle, 11436 anywhere else), the start failure messages, and the unload request body
- Dictation with a fake engine and a fake microphone: the audio ring wrapping and zeroing, events under 8 KiB with long text split at UTF-8 boundaries, grey words becoming final in one event, no text after a cancel, a lock, or a new session, a silent mic ending as `input_lost`, a failed capture reading as `denied` or `no_input`, an engine that stops taking sound filling the ring and ending as `engine_failed`, a Stop that the engine never settles ending as `engine_failed`, and the commands refusing while locked, except stop
- A session lock or a quit ending dictation, even with the lock off. The idle clock and the display hold wait for the mic to be really on, so a session still waiting for the macOS prompt holds neither, and every way a session ends lets go of both. The power assertion has a fake for the logic and an opt-in live test that asks `pmset -g assertions`.
- The model state: `checking` until macOS answers, `dictation.start` refusing with `SpeechModelChecking` meanwhile, a status call that never loads the library or waits for it, and a Mac with no English model reading as `no_english`
- Tidy: the checks on the model’s reply (word count, new words, lead-in lines, quotes), and each failure message
- The speech library: finding it from the app path or `SAGE_SPEECH_LIB_PATH`, and a skipped live test that runs the real engine on a recorded clip
- Reading loaded models from `/api/ps`, and the unload flag that lock sets and unlock clears

## The security tests

`security-tests/` holds small tests that read source files and scripts to check a security rule still holds. `make test` runs them all:

- **Chat token**: Chat routes, the workflow routes, and cancelling a session all need the agent-server token, and health stays public (`eve-auth-admits-everyone.test.ts`, `cancel-session-no-token.test.ts`).
- **Chat readiness**: a program on port 2001 that answers health cannot make Chat ready unless Sage started its own server (`chat-standin-health.test.ts`).
- **Local models**: the Chat agent pins Ollama to `127.0.0.1` and to the port Sage sets, packaged Chat does not copy Sage’s environment, and the bundled Ollama server gets only its own `OLLAMA_*` settings (`ollama-env.test.ts`, `sidecar-env-passthrough.test.ts`).
- **Context length**: a request cannot raise the context length above the picker maximum (`context-length-uncapped.test.ts`).
- **Web view**: the page allows no inline script, and export writes only to the folder you picked (`csp.test.ts`, `export-dest.test.ts`).
- **Packaging**: the copy targets `Sage.app`, and the bundle ships no dev modules (`copy-agent-target.test.ts`, `agent-dev-modules.sh`).
- **Dictation**: the web view never uses `getUserMedia`, `MediaRecorder`, or `AudioContext`. The dictation Zig and Swift files write no files, log no text, and open no connection. The audio ring is zeroed, and the speech library zeroes the copies it makes. The microphone text is set before the app is signed. The Sage executable loads the speech library at run time and does not link the Speech framework, which `otool -L` confirms when a build exists. It loads IOKit at run time too (`dictation-no-audio.test.ts`).
- **Seeding**: `make seed-dev` builds its automation binary under `zig-out/seed`, names only the dev app, and reads the seed files and builds before it resets. With `CHATS=1`, it checks the models before the reset, points the Chat agent at the dev app's `agent-server.json`, and plays Ben with the local model, never a cloud one (`seed-dev-dev-only.sh`).
- **Screenshots**: `make screenshots` keeps its journal in a fresh scratch folder, gives its app a bundle id of its own, builds only under `zig-out/screenshots-build`, and stops what its app started before it deletes the build. It never turns Touch ID or the lock off and never downloads a model. A journal in `SAGE_DATA_DIR` keeps its Touch ID key under a Keychain service of its own, and the route and appearance commands work only in automation builds (`screenshots-isolated.sh`).
- **Evals**: `make eval` sends the token to a URL target and refuses `--url` in `ARGS` (`eval-server-token.test.ts`). It leaves no automation binary in `zig-out/bin/` (`eval-leftover-automation.test.ts`), and it opens only the throwaway `app.db` (`eval-ignores-data-dir.test.ts`).
- **Cloud judge**: the AI Gateway keys reach only the `eve eval` processes, never Sage, `eve dev`, Ollama, or the seed script (`eval-gateway-keys.test.ts`). Nothing under `agent/agent/` mentions an eval variable, the eval prompts folder, or the gateway, and the runner swaps only `instructions.md` in its copy of the app (`agent-has-no-eval-hooks.test.ts`).

To run the TypeScript ones alone, use `node --test --experimental-strip-types security-tests/*.test.ts`.

## Driving a running app

Builds made with the automation flag include the Native SDK’s automation server. To make one and start it from the project directory:

```bash
make fe-build
native build -Dautomation=true
./zig-out/bin/Sage
```

That replaces `zig-out/bin/Sage` with an automation build, so run `make build` afterward for a normal binary. `make eval`, `make seed-dev`, and `make screenshots` avoid this. Each installs its own automation build, under `zig-out/eval-mem0` and `zig-out/eval-mem1` (one for each memory value), `zig-out/seed`, and `zig-out/screenshots-build`, as [Eval suite](../agent/evals.md#what-a-run-does) and [Scripts](../../scripts/README.md#seeding-the-dev-app) explain.

`make eval` and `make screenshots` set `SAGE_DATA_DIR`. Sage then keeps the window's saved size and place in that folder too, so they never move the window of the Sage you use. It also keeps the Touch ID key under a Keychain service of its own, as [The Keychain item](keychain.md#the-keychain-item) explains. Automation builds never check for updates at launch, so no update sheet covers the window a script drives.

The automation server watches `.zig-cache/native-sdk-automation/` under the app’s working directory for command files. Call the CLI from that same directory, which is the project directory for a local smoke test:

```bash
native automate wait
native automate snapshot
native automate bridge '{"id":"smoke","command":"lock.status","payload":{}}'
```

With the lock on and Sage unlocked, check that a session lock works:

```bash
native automate native-command app.lock
native automate bridge '{"id":"locked","command":"lock.status","payload":{}}'
```

The status response should include `"unlocked":false`.

Automation builds also take `app.route:<route>`, which opens a screen such as `app.route:settings.models`, and `app.appearance:light` or `app.appearance:dark`. `make screenshots` uses them, as [Scripts](../../scripts/README.md#opening-a-screen) explains. Other builds ignore both.

## The automation origin

Bridge calls from automation arrive from the origin `zero://inline`. Sage allows that origin only in automation builds, because `src/main.zig` checks the same build flag. A packaged build allows bridge calls only from `zero://app`, the policy `app.json` lists, and `make dev` also allows the Vite server at `http://127.0.0.1:5173`.

Two things follow:

- A smoke test that drives the bridge needs an automation build.
- A packaged build has no automation server, so the extra origin matches nothing and automation files are ignored.
