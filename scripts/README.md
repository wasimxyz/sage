# Scripts

These shell scripts package the Mac app, run the eval suite, reset and seed the dev app, and capture screenshots. Each section names the `make` command that runs them.

The seeding and grading steps live in `agent/scripts/`. The canirun catalog refresh lives in `frontend/scripts/`, as [Models](../docs/models.md#how-recommendations-work) explains.

## Packaging

`make package` builds the app and the speech library, then runs `copy-agent-into-app.sh` with the app and `zig-out/lib/libSageSpeech.dylib`. `zig build package` runs that same script and passes the app path and the library it built.

`copy-agent-into-app.sh` copies the built Chat agent into `Sage.app`, along with the pinned Node.js and Ollama and the speech library. Before it finishes, it sets the microphone text, checks that the copied Chat channel still allows `zero://app` (the address the packaged app uses to call Chat), and signs the app again so the copy still opens. The scripts it runs first are:

1. `refuse-packaged-dev-modules.sh` stops the copy when `typescript`, `@types`, or `@vercel/blob` is still installed in the copied agent.
2. `fetch-node.sh` downloads Node.js 24.22.2 once into `third_party/node/`, checks that the download is the expected file, and copies the `node` program into the app.
3. `fetch-ollama.sh` downloads Ollama 0.40.15 once into `third_party/ollama/`, checks the archive and its LICENSE against pinned SHA-256 values, keeps only the arm64 code, and copies the tree into `Contents/Resources/ollama/`.

The script then does two things for [dictation](../docs/dictation.md):

- **The speech library**: it copies `libSageSpeech.dylib` into `Contents/Frameworks/` and stops if the library is missing. Sage loads it from there at run time, and the Sage executable never links it.
- **The microphone text**: it replaces `NSMicrophoneUsageDescription` in `Info.plist` with “Sage listens only while you dictate. Audio stays on this Mac and is never saved.” using PlistBuddy. `native package` writes its own text, which says “recording”. The script adds the key if `native package` left it out. This step must run before the final signing, because editing the plist after it breaks the seal.

`make test` runs `security-tests/dictation-no-audio.test.ts`, which checks that the plist step and the library copy come before `codesign`, and that the text matches the one `build.zig` gives the dev build.

`make package-archive` runs two more scripts after that copy. Both read the version from the app’s `Info.plist` and work on the app that already contains the Chat agent and Node.js.

- `archive-packaged-app.sh` builds `zig-out/package/Sage-<version>-macos.dmg`.
- `update-archive-packaged-app.sh` builds `zig-out/package/Sage-<version>-macos-update.zip`, the file installed copies download. It stands in for `native package --update-archive`, which zips the app before the Chat agent is copied in. It also refuses an app with no executable `Resources/ollama/ollama` and an app with no `Contents/Frameworks/libSageSpeech.dylib`.

`zig build package` runs `update-archive-packaged-app.sh` itself when `app.json` has an `updates` block.

`fetch-ollama.sh` with no argument fills the same cache and prints the path of the binary. `make dev`, `make seed-dev`, and `make eval` pass that path to Sage as `SAGE_OLLAMA_PATH`. A Sage outside an app bundle runs that copy on port 11436, and `make eval` also uses it for its pulls.

`make dev` also passes `SAGE_SPEECH_LIB_PATH`, the path of the speech library the build installed in `zig-out/lib/`. A packaged app ignores that variable and loads its own copy.

Building the speech library needs the macOS 26 SDK. The release workflow, `.github/workflows/release.yml`, runs on `macos-26` and stops early when the SDK is older. `ci.yml` stays on `macos-latest`, because `native check` and `native test` do not build the library. On a Mac without that SDK, add `-Dspeech=false` to the build, and Sage runs without the mic.

## Releasing

`release-version.sh` checks that every version in the repo matches `app.json`: `build.zig.zon`, each `package.json`, and the root entries of each `package-lock.json`. `make check` runs it with no arguments. The release workflow runs it with the pushed tag, which must be `v<version>` or `v<version>-rc.<n>`, and takes the version and prerelease flag from its output. [Releasing Sage](../docs/release.md) has the full steps.

`make test` runs `release-version.test.sh`, which checks the script against a copy of those files.

## Eval

`make eval` runs `eval-run.sh`. It gets the pinned Ollama from `fetch-ollama.sh`, and it stops if port 11436 is in use, which `make dev` also uses. The runner loads settings, grades Dream and Chat, writes reports under `agent/evals/reports/`, and then asks whether to upload them. The full sequence is in [Eval suite internals](../agent/evals/README.md).

`eval-run.sh` and `eval-upload.sh` both load settings through `eval-env.sh`, which reads `agent/.env`, then `agent/.env.local`. A variable already set in the shell keeps its value.

`make eval-upload` runs `eval-upload.sh` on its own, to upload reports from an earlier run. On a terminal it asks first, and the default is no. When input is not a terminal, it skips the upload.

`make test` runs `eval-env.test.sh`. That check confirms the load order above.

## Resetting the dev app

`make reset-dev` runs `reset-dev.sh`. It deletes what the dev app keeps, so the next `make dev` opens [first-launch setup](../docs/onboarding.md) the way a new user sees it. It never touches the packaged app’s data in `com.wasimxyz.sage`, and the models in `~/.ollama` stay.

The script deletes these:

- `~/Library/Application Support/com.wasimxyz.sage-dev`: `app.db`, the memory build marker, and window positions
- `agent/.eve/.workflow-data`: the Chat session files `make dev` writes
- `~/Library/WebKit/Sage`, `~/Library/Caches/Sage`, and `~/Library/HTTPStorages/Sage.binarycookies`: the web view’s local storage and caches
- The `journal-data-key` Keychain item for `com.wasimxyz.sage-dev`: the Touch ID copy of the data key. A dev build is ad hoc signed, so the item lives in the login keychain, as [The Touch ID Keychain mirror](../docs/security/keychain.md#unsigned-builds) explains

The script refuses to start in these cases:

- A process has the dev `app.db` open, or the Chat agent answers on port 2000. Quit Sage and stop `make dev` first.
- Input is not a terminal and `YES=1` is not set.

Otherwise it lists what it found and asks first, and the default is no. `make reset-dev YES=1` skips the question. The script ignores `SAGE_DATA_DIR`, so it never deletes a folder the environment names. It keeps no backup, so copy the data folder first if you want to keep a dev journal.

When you say no, the script exits 0. Set `RESET_DEV_DECLINED_STATUS` to change that status, so `seed-dev.sh` can tell a declined reset from one that ran.

`make test` runs `reset-dev.test.sh`. It runs the script against a temporary home folder, with stand-ins for `lsof`, `curl`, and `security`.

## Seeding the dev app

`make seed-dev` runs `seed-dev.sh`. It resets the dev app and fills its journal with sample entries, so the next `make dev` has entries in the Journal tab. It never touches the packaged app’s data, and the models in `~/.ollama` stay. It does not run Dream or start a chat. Run those by hand.

The entries are the Markdown files in `scripts/seed/`. Each has a `title` and a `date` in frontmatter, and the rest of the file is the body. `make seed-dev SEED=/path/to/folder` seeds a different folder of files in the same format.

### Seed dates

The dates in the files are a baseline. The entries name weekdays, such as trivia on Thursdays, so the script moves every date by the same whole number of weeks:

1. The latest date across the files is the baseline.
2. The target is the last day on or before today that falls on the same weekday.
3. Every date moves by the days from the baseline to the target.

The newest entry lands in the last 7 days, on today if today is that weekday. Each entry keeps its weekday, and the gaps between entries stay the same. Dates are calendar days in your time zone. For example, if the newest file says Sunday 2026-10-25 and today is Wednesday 2026-11-11, every date moves 14 days, so 2026-07-30 becomes 2026-08-13.

To change the entries, edit the files and leave the dates as a baseline. The script works out the move each time it runs.

### Steps

The script runs these steps in order and stops at the first failure:

1. It reads every seed file and works out the dates. A file with no title, a bad date, or an empty body stops the script before it builds or deletes anything. It prints how far the dates move.
2. It builds an automation binary under `zig-out/seed`, so `zig-out/bin/Sage` stays a normal build. `SAGE_MEMORY=true make seed-dev` builds it with memory on, to match `SAGE_MEMORY=true make dev`.
3. It runs `reset-dev.sh`, which asks first and refuses while the dev app or the Chat agent is running. `make seed-dev YES=1` skips the question. If you say no, the script stops and nothing is deleted. Because of the reset, a second run replaces the entries instead of adding them again.
4. It starts the binary as the dev app, from a scratch folder with a blank page. It gives the app the Chat sessions folder `make dev` uses, so the app can finish switching memory off. It saves each entry through `journal.save`, as `make eval` does. Word counts match what Import saves for the same file.
5. It stops Sage, then deletes the scratch folder and `zig-out/seed`.

The new journal has no lock and no encryption. It has entries, so the next `make dev` skips setup, as [First-launch setup](../docs/onboarding.md#when-setup-shows) explains. Run `make reset-dev` to see setup again.

When `make dev` loads the entries, Sage embeds them, as [The journal](../docs/journal.md#writing-and-saving) explains. Start Dream from the sidebar to write summaries and memories.

`make test` runs `security-tests/seed-dev-dev-only.sh`. It checks that the script names only the dev app, builds only under `zig-out/seed`, reads the seed files and builds before it resets, and gives the app the Chat sessions folder. `make test` also runs `agent/scripts/seed-dev.test.ts`, which checks that the seed files parse and that `--check` names a bad file, and `agent/scripts/seed-dates.test.ts`, which checks the date move.

## Screenshots

`make screenshots` runs `screenshots.sh`. It captures the packaged app's screens in light and dark, for the website and the docs. It saves one PNG per screen and appearance in `zig-out/screenshots/`, such as `chat-dark.png`. `make screenshots OUT=/path/to/folder` saves them somewhere else. It never opens your own journal.

The shots are the five setup steps, Home, an open entry, Chat, the four Settings tabs, and the lock screen. The window is 1280 by 800 points, so the files are 2560 by 1600 on a Retina display. They have no shadow, and the corners outside the window are clear.

### What it needs

- **Screen Recording access**: the terminal you run it in needs it. Without it, `screencapture` saves only the desktop. The script checks first. If access is off, macOS asks for it, and you run the script again after you restart the terminal.
- **No other Sage running**: the copy it builds is a packaged app, so it uses ports 11435 and 2001, as your installed Sage does. The script stops if either port is in use.
- **Sage's two models**: `nomic-embed-text` and `qwen3.5:9b` must already be in `~/.ollama`. Setup's Local AI step downloads any model that's missing as soon as it opens, so the script checks first and stops if one is missing. Download it in your own Sage under Settings > Models. The script ignores `SAGE_EMBED_MODEL` and `SAGE_SUMMARY_MODEL`.
- **Hands off**: a Sage window opens, comes to the front, and changes screens by itself for about a minute. Keep the pointer off it, since a hover changes what the shot shows. If another app comes to the front, the script asks you to click the Sage title bar and waits.

Settings > Models and setup's Local AI step show the models in `~/.ollama` and this Mac's chip and memory.

### Steps

1. It checks for Screen Recording access and reads the seed files, before the long build.
2. It builds a packaged app the way `make package` does, with automation on and memory off, under `zig-out/screenshots-build`. `zig-out/bin` and `zig-out/package` stay as they are. Before the copy script signs the app, it changes the bundle id to `com.wasimxyz.sage.screenshots`. That keeps the copy's web storage apart from your app's. Automation builds don't check for updates at launch, so no update sheet covers the window.
3. It starts the app from a scratch folder, with `SAGE_DATA_DIR` set to a journal in that folder. The window's saved size and place live there too, so the script writes a 1280 by 800 frame there first. `native automate resize` resizes a canvas, not the window.
4. `agent/scripts/screenshots.ts` drives the app through the automation server:
   1. It waits for the copy's local AI to start and checks that both models are installed.
   2. It captures each setup step on the empty journal, saving the step with `onboarding.save` and reloading the page.
   3. It finishes setup, turns the reminders off, and saves the entries in `scripts/seed/` with the same date move as `make seed-dev`.
   4. It saves the chat in `agent/scripts/screenshot-chat.ts`, a question and answer about three Sunday entries with one journal search. The chat is written by hand, so it needs no model and is the same on every run.
   5. It waits for Sage to embed the new entries, then captures Home, the entry, Chat, and Settings.
   6. It sets a random password, turns Touch ID on, and captures Settings > Security. Then it locks the app and captures the lock screen.
5. It stops Sage and anything the copy left running. Ollama and Chat run apart from Sage, so a copy that crashes would leave them on ports 11435 and 2001. Then it deletes the scratch folder, the build, and the copy's web storage and caches under `~/Library` and `/var/folders`. Packaging leaves out the agent's dev modules, so the script installs them again.

Encryption stays off, so no data key goes in the Keychain. A journal in `SAGE_DATA_DIR` keeps its Touch ID key under a Keychain service of its own, as [The Keychain item](../docs/security/keychain.md#the-keychain-item) explains, so the copy can't reach the item your own Sage uses. The script still never turns Touch ID or the lock off.

### Opening a screen

The automation server can't click in the web view, so automation builds take two more commands:

- `native automate native-command app.route:<route>` opens a screen. The route is the hash route with dots for slashes, such as `app.route:chat.3` for `#/chat/3` or `app.route:settings.models`, because the automation server refuses a command name with a slash in it. The page sets its hash route and clears focus, so no caret shows. Sending the same route again only clears focus.
- `native automate native-command app.appearance:light` or `app.appearance:dark` holds the app in that appearance, whatever the system uses.

`src/main.zig` handles them only when the build has automation on, so a packaged app ignores them. The automation server reports a command it refuses only as an `error event` line in its snapshot, so the script checks for one after each command. First it sends `app.sync`, a name Sage does nothing with, and waits for the command queue to empty. The server takes one command per frame and writes that frame's snapshot before it takes the next, so by then the snapshot shows any error from the first command. [Testing the lock and encryption](../docs/security/testing.md#driving-a-running-app) has more on the automation server.

The automation server keeps only the last bridge answer, in `bridge-response.txt`. Once the page has entries to load, it makes its own bridge calls, which can write over an answer before the script reads it. So the script saves the entries and the chat while the page is still on setup. Later, it sends a command again only when repeating it changes nothing, such as `embeddings.pending`. A first password can't be set twice, so when that answer is lost, the script asks `lock.status` instead.

To change the shots, edit the lists at the top of `agent/scripts/screenshots.ts`. To change the chat, edit `agent/scripts/screenshot-chat.ts`.

`make test` runs `security-tests/screenshots-isolated.sh`. It checks that the script keeps the journal in a scratch folder, changes the bundle id before signing, builds only under `zig-out/screenshots-build`, and stops what the copy started before it deletes the build. It also checks that the script never turns Touch ID or the lock off and never downloads a model. `make test` also runs `agent/scripts/screenshots.test.ts`, which replays the chat through eve's reducer and checks the shot list.

## Dictation voice test

`dictation-spike/` holds the test that picks the speech engine for dictation. It runs your own recorded clips through Apple's SpeechAnalyzer and NVIDIA Parakeet, then scores accuracy and how fast text shows up. No `make` command runs it. Its [README](dictation-spike/README.md) has the steps.
