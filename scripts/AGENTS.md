# Scripts

Read `scripts/README.md` first. For releases, read `docs/release.md`. Scripts here are POSIX `sh` with `set -eu`.

## Pinned downloads

- `fetch-node.sh` and `fetch-ollama.sh` pin a version and its SHA-256 values. A bump changes the version, every SHA-256, and the versions in `scripts/README.md`. An Ollama bump also changes `docs/release.md`.
- Bump a pin in a small PR of its own.
- `third_party/` is their download cache. Never commit it or edit it by hand.

## Version bumps

- A release bump changes 13 lines in the 9 files that `release-version.sh` checks. `docs/release.md` lists them.
- Set each lockfile's root `version` fields by name, with Node. Never use `sed`, because other packages in the same lockfile share the version number.
- A new `package.json` goes in the list in `release-version.sh` and `release-version.test.sh`.

## Dev data

- Dev scripts never read or write the packaged app's data, Keychain item, or window state.
- A script that resets data checks every input, and builds, before it deletes anything.
- There is one seeding path. A tool that needs sample data copies the dev journal that `make seed-dev` wrote, instead of seeding its own fixtures in code.
- Seed text is used exactly as written, and seeding again adds no duplicates. Tests pin the counts: 25 entries and 5 chats in `agent/scripts/seed-dev.test.ts`, and 15 shots in `agent/scripts/screenshots.test.ts`.

## Stopping processes

A bug in the `make screenshots` cleanup once sent SIGTERM to every process the user owned.

- Signal only process ids the script started.
- Pass an env var to the command that reads it, not to the command before it in a pipe.
- Match on argv[0], refuse an empty pattern, and cap the count.
- Test with fakes started by `bash -c 'exec -a "<path>" /bin/sleep 30'`, never against the live process table.

## Screenshots

- `make screenshots` needs Screen Recording for the app that runs it.
- `native automate native-command` refuses a name with `/` but still exits 0. Check the snapshot for `InvalidCommand`.
- `native automate resize` changes only the canvas. Write the window size to `$SAGE_DATA_DIR/State/windows.zon` before launch.
- `bridge-response.txt` holds only the last answer, and the page's own calls overwrite it.
- Report the exit code and the number of captures.

## Rules

- `security-tests/` greps several of these scripts. Run `make test` after you reword one.
- A new `*.test.sh` runs only after you add it to the `test-scripts` target in the `Makefile`.
