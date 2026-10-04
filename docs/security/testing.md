# Testing the lock and encryption

This page explains how the lock and encryption are tested: the unit suite, the security tests, and the automation server that drives a running app. Read it before you write a smoke test.

## What `make test` runs

`make test` runs every suite that needs no Ollama:

- The Zig tests, against an in-memory SQLite database with no window
- The frontend unit tests in `frontend/src/lib/`
- The agent tests: eval fixtures, scripts such as the dev auth hook, and the encrypted session storage in `agent/packages/world-encrypted-local`
- The eval viewer unit tests in `eval-viewer/lib/reports/`
- `scripts/eval-env.test.sh`, which checks the order `make eval` loads settings in
- The security tests in `security-tests/`

`make check` validates `app.json`, checks the pinned Native SDK CLI version, and runs the frontend lint and type checks.

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

## The security tests

`security-tests/` holds small tests that read source files and scripts to check a security rule still holds. `make test` runs them all:

- **Chat token**: Chat routes, the workflow routes, and cancelling a session all need the agent-server token, and health stays public (`eve-auth-admits-everyone.test.ts`, `cancel-session-no-token.test.ts`).
- **Chat readiness**: a program on port 2001 that answers health cannot make Chat ready unless Sage started its own server (`chat-standin-health.test.ts`).
- **Local models**: the Chat agent pins Ollama to `127.0.0.1`, and packaged Chat does not copy Sage’s environment (`ollama-env.test.ts`, `sidecar-env-passthrough.test.ts`).
- **Context length**: a request cannot raise the context length above the picker maximum (`context-length-uncapped.test.ts`).
- **Web view**: the page allows no inline script, and export writes only to the folder you picked (`csp.test.ts`, `export-dest.test.ts`).
- **Packaging**: the copy targets `Sage.app`, and the bundle ships no dev modules (`copy-agent-target.test.ts`, `agent-dev-modules.sh`).
- **Evals**: `make eval` sends the token to a URL target, leaves no automation binary in `zig-out/bin/`, and opens only the throwaway `app.db` (`eval-server-token.sh`, `eval-leftover-automation.sh`, `eval-ignores-data-dir.sh`).

To run the TypeScript ones alone, use `node --test --experimental-strip-types security-tests/*.test.ts`.

## Driving a running app

Builds made with the automation flag include the Native SDK’s automation server. To make one and start it from the project directory:

```bash
make fe-build
native build -Dautomation=true
./zig-out/bin/Sage
```

That replaces `zig-out/bin/Sage` with an automation build, so run `make build` afterward for a normal binary. `make eval` avoids this by installing its own automation build under `zig-out/eval`, as [Eval suite](../agent/evals.md#what-a-run-does) explains.

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

## The automation origin

Bridge calls from automation arrive from the origin `zero://inline`. Sage allows that origin only in automation builds, because `src/main.zig` checks the same build flag. A packaged build allows bridge calls only from `zero://app`, the policy `app.json` lists, and `make dev` also allows the Vite server at `http://127.0.0.1:5173`.

Two things follow:

- A smoke test that drives the bridge needs an automation build.
- A packaged build has no automation server, so the extra origin matches nothing and automation files are ignored.
