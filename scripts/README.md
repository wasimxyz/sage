# Scripts

These shell scripts package the Mac app, run the eval suite, and reset the dev app. Each section names the `make` command that runs them.

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
