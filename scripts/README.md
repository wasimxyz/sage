# Scripts

These shell scripts package the Mac app, run the eval suite, and reset and seed the dev app. Each section names the `make` command that runs them.

The seeding and grading steps live in `agent/scripts/`. The canirun catalog refresh lives in `frontend/scripts/`, as [Models](../docs/models.md#how-recommendations-work) explains.

## Packaging

`make package` builds the app, then runs `copy-agent-into-app.sh`. `zig build package` runs that same script and passes the app path.

`copy-agent-into-app.sh` copies the built Chat agent into `Sage.app`. Before it finishes, it runs the two scripts below, checks that the copied Chat channel still allows `zero://app` (the address the packaged app uses to call Chat), and signs the app again so the copy still opens.

1. `refuse-packaged-dev-modules.sh` stops the copy when `typescript`, `@types`, or `@vercel/blob` is still installed in the copied agent.
2. `fetch-node.sh` downloads Node.js 24.21.0 once into `third_party/node/`, checks that the download is the expected file, and copies the `node` program into the app.

`make package-archive` runs two more scripts after that copy. Both read the version from the app’s `Info.plist` and work on the app that already contains the Chat agent and Node.js.

- `archive-packaged-app.sh` builds `zig-out/package/Sage-<version>-macos.dmg`.
- `update-archive-packaged-app.sh` builds `zig-out/package/Sage-<version>-macos-update.zip`, the file installed copies download. It stands in for `native package --update-archive`, which zips the app before the Chat agent is copied in.

`zig build package` runs `update-archive-packaged-app.sh` itself when `app.json` has an `updates` block.

## Releasing

`release-version.sh` checks that every version in the repo matches `app.json`: `build.zig.zon`, each `package.json`, and the root entries of each `package-lock.json`. `make check` runs it with no arguments. The release workflow runs it with the pushed tag, which must be `v<version>` or `v<version>-rc.<n>`, and takes the version and prerelease flag from its output. [Releasing Sage](../docs/release.md) has the full steps.

`make test` runs `release-version.test.sh`, which checks the script against a copy of those files.

## Eval

`make eval` runs `eval-run.sh`. The runner loads settings, grades Dream and Chat, writes reports under `agent/evals/reports/`, and then asks whether to upload them. The full sequence is in [Eval suite internals](../agent/evals/README.md).

`eval-run.sh` and `eval-upload.sh` both load settings through `eval-env.sh`, which reads `agent/.env`, then `agent/.env.local`. A variable already set in the shell keeps its value.

`make eval-upload` runs `eval-upload.sh` on its own, to upload reports from an earlier run. On a terminal it asks first, and the default is no. When input is not a terminal, it skips the upload.

`make test` runs `eval-env.test.sh`. That check confirms the load order above.

## Resetting the dev app

`make reset-dev` runs `reset-dev.sh`. It deletes what the dev app keeps, so the next `make dev` opens [first-launch setup](../docs/onboarding.md) the way a new user sees it. It never touches the packaged app’s data in `com.wasimxyz.sage`, and Ollama keeps its app and models.

The script deletes these:

- `~/Library/Application Support/com.wasimxyz.sage-dev`: `app.db`, the memory build marker, and window positions
- `agent/.eve/.workflow-data`: the Chat session files `make dev` writes
- `~/Library/WebKit/Sage`, `~/Library/Caches/Sage`, and `~/Library/HTTPStorages/Sage.binarycookies`: the web view’s local storage and caches
- The `journal-data-key` Keychain item for `com.wasimxyz.sage-dev`: the Touch ID copy of the data key. A dev build is ad hoc signed, so the item lives in the login keychain, as [The Touch ID Keychain mirror](../docs/security/keychain.md#unsigned-builds) explains

The script refuses to start in these cases:

- A process has the dev `app.db` open, or the Chat agent answers on port 2000. Quit Sage and stop `make dev` first.
- Input is not a terminal and `YES=1` is not set.

Otherwise it lists what it found and asks first, and the default is no. `make reset-dev YES=1` skips the question. The script ignores `SAGE_DATA_DIR`, so it never deletes a folder the environment names. It keeps no backup, so copy the data folder first if you want to keep a dev journal.

`make test` runs `reset-dev.test.sh`. It runs the script against a temporary home folder, with stand-ins for `lsof`, `curl`, and `security`.

## Seeding the dev app

`make seed-dev` runs `seed-dev.sh`. It resets the dev app, fills its journal with sample entries, and runs Dream, so the next `make dev` opens Home with entries and summaries. It never touches the packaged app's data, and Ollama keeps its app and models.

The entries are the Markdown files in `scripts/seed/`. Each has a `title` and a `date` in frontmatter. `make seed-dev SEED=/path/to/folder` seeds a different folder of files in the same format.

The script runs these steps in order and stops at the first failure:

1. It checks that Ollama is running and has both models, which [First-launch setup](../docs/onboarding.md#step-1-local-ai) names. If not, it stops before it deletes anything.
2. It builds an automation binary under `zig-out/seed`, so `zig-out/bin/Sage` stays a normal build. `SAGE_MEMORY=true make seed-dev` builds it with memory on, to match `SAGE_MEMORY=true make dev`.
3. It runs `reset-dev.sh`, which asks first and refuses while the dev app or the Chat agent is running. `make seed-dev YES=1` skips the question. If you say no, the script stops.
4. It starts the binary as the dev app, from a scratch folder with a blank page. It saves each entry through `journal.save`, as `make eval` does, then runs Dream and waits for it to finish.
5. It stops Sage, then deletes the scratch folder and `zig-out/seed`.

The new journal has no lock and no encryption. It has entries, so the next `make dev` skips setup, as [First-launch setup](../docs/onboarding.md#when-setup-shows) explains. Run `make reset-dev` to see setup again.

If Dream cannot start, the entries stay saved and the script exits with the reason. Start Dream from the sidebar later.

`make test` runs `security-tests/seed-dev-dev-only.sh`. It checks that the script names only the dev app, builds only under `zig-out/seed`, and builds before it resets. `make test` also runs `agent/scripts/seed-dev.test.ts`, which checks that the seed files parse.
