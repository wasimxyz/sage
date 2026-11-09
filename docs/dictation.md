# Dictation

This page explains how you dictate into an entry or a Chat message: how it starts and stops, where the words go, what it needs from macOS, and how the pieces fit together. The core is `src/dictation.zig`, the engine is `src/speech/SageSpeech.swift`, and the screen code is `frontend/src/components/dictation-provider.tsx` and `frontend/src/lib/dictation-plugin.ts`.

Dictation is a way to type, not a kind of entry. The words go into the entry like typed text, so saving, search, Dream, and export treat them the same way. Sage needs macOS 26 or later for it. On an older Mac the mic buttons are hidden.

## Starting and stopping

A mic button sits in the entry header, before the ⋯ menu. In Chat, it sits in the message box beside the model picker, and only a live conversation has one. ⌘D does the same as the button. It works while an entry is open or Chat is on screen, and it does nothing on Home, Memories, and Settings. It waits while a dialog, popover, or menu is open, and holding the key does not turn the mic on and off again.

The button reads **Starting…** until the mic is on, **Listening** while you speak, and **Finishing…** while the engine settles the last words. Only one dictation runs at a time, so the other mic is off while one is on. The entry mic is also off while an entry loads.

To stop, press the button or ⌘D again, or press Esc. Esc does not stop dictation when a menu or dialog took it, or when an input method is composing text.

## Where the words go

### In an entry

New words land at the cursor. These cases differ:

- **The title has focus**, or you have not clicked into the body since the entry opened: the words go to the end of the body, in a new paragraph unless the last one is empty. A first ⌘D never lands at the top of an old entry.
- **You click somewhere else mid-phrase**: the phrase in progress settles where it started, and the next phrase starts at the new cursor.
- **You type while dictating**: the spot moves along with your typing.
- **An input method is composing**: settled words wait until it finishes, and the grey words keep showing.

Dictated words are plain text. They have no marks, so autosave, undo, and search treat them like typing.

### In Chat

Settled words are added to the end of the message box, with the space they need. You press Send as usual. Sending ends dictation, and grey words that have not settled are not sent. If Dream starts and turns the box off, dictation stops, and the words that settled stay in the box.

## Grey and settled text

Words show in two steps. Grey words are the engine’s first guess, and they can still change. They appear about a second after you speak. When you pause, the guess settles and turns into normal text, about 1.5s later.

In an entry, grey words are drawn at the cursor and are never part of the entry, so they never reach the saved Markdown. In Chat, they show in a muted line under the message box. The core sends at most the last 1 KiB of grey text, starting with “…” when it cut the start off.

## What stops dictation

These end a session. Each one has a reason, which the core sends in `dictation:stopped`:

- **You stop it** (`user`): the core stops listening at once, lets the engine finish what it already heard, and sends those words. The grey words become normal text. This takes about 0.1s, and the core waits up to 8s.
- **You leave** (`discarded`): you open another entry, start a new one, close or delete the entry, or go to Home, Chat, Memories, or Settings. In Chat, it is sending a message, opening another chat, or leaving Chat. The session ends at once.
- **Sage locks** (`locked`): this covers the lock, the idle lock, **Sage > Lock**, the Mac or display going to sleep, and the screen saver starting. These stop dictation even when the lock is off. [The app lock](security/lock.md#dictation-and-the-lock) has the rest.
- **Sage quits** (`quit`).
- **The mic cannot be used**: `denied` when you refuse access, `no_input` when there is no working mic, and `input_lost` when a started mic sends no sound for 2s. That can happen when you connect AirPods or the Mac wakes. The Native SDK does not report these changes, so Sage watches for them.
- **The engine fails** (`engine_failed`): it stopped, or it fell a minute behind the mic.

What happens to grey words depends on the reason:

- **In an entry**, the page puts the grey words in as normal text for every reason it hears about. When you leave, they are in the entry before the save that goes with leaving. A grey tail that was cut at 1 KiB keeps its “…” and loses its start.
- **In Chat**, grey words are kept for every reason except leaving, where they are dropped. Words that settled stay in the box.
- **When Sage locks or quits**, the core drops any words it has not sent yet. Saving also waits one second after the last change, and a locked Sage refuses saves. With the lock on, the last second of words before a lock may not be saved.

A stop with a message shows it in a toast. A refused microphone adds **Open System Settings**.

## Audio is never saved

Sage captures sound only while a session runs. The core keeps about 60s of it in memory and zeroes it when the session ends. Sound is never written to a file, never logged, and never sent to the web view, which only receives text. Sage never logs transcript text either, and the core holds the text only long enough to pass it on.

The engine runs on this Mac. `security-tests/dictation-no-audio.test.ts` checks these rules in the source: the web view has no `getUserMedia`, `MediaRecorder`, or `AudioContext`, the dictation source files write no files and log no text, and the app does not link the Speech framework.

## The microphone permission

The first time you dictate, macOS asks whether Sage may use the microphone. The prompt reads “Sage listens only while you dictate. Audio stays on this Mac and is never saved.” The text comes from `microphone_usage_text` in `build.zig` for `make dev`. For a packaged app, `scripts/copy-agent-into-app.sh` writes it into `Info.plist` with PlistBuddy, before it signs the app. Sage does not need the Speech Recognition permission, only the microphone.

Sage builds are signed ad hoc, so macOS treats each update as a new app and asks for the microphone again. That is accepted for now.

If you refuse, Sage says so and offers **Open System Settings**, which opens Privacy & Security > Microphone. The core fixes that address, and the web view never picks one. `src/microphone.zig` reads the permission with `AVCaptureDevice authorizationStatusForMediaType:`, because the Native SDK reports a refused permission, a missing mic, and a failed engine start as the same failure.

## The engine

Sage uses Apple’s on-device speech engine: SpeechAnalyzer with SpeechTranscriber, in its speech mode, asking for grey results and fast results. It is part of macOS 26 and later. The Native SDK captures 16 kHz mono sound. SpeechAnalyzer asked for exactly that on the Macs tested, so the sound needs no conversion, and the library converts it if another Mac asks for a different format.

The engine needs an English speech model. macOS downloads it, keeps it up to date, and stores it outside Sage, so it is not in the Ollama models folder. Sage cannot delete it. Settings > Models shows a **Speech** section with a **Speech model** row:

- **Installed**, or **Not downloaded** with a **Download** button
- **Downloading (40%)** while macOS fetches it
- **Download failed**, with **Try again** and the reason

If you press the mic without the model, Sage starts the download and shows its progress in a toast. When it finishes, the toast says to press ⌘D. Dictation is English only.

### Why this engine

A voice test chose the engine. It ran six clips of one person’s voice through Apple and NVIDIA Parakeet on an M2 Pro with 16 GB and the MacBook Pro microphone. [The test and its report](../scripts/dictation-spike/README.md) are in the repo. Its results:

- **Accuracy**: Apple’s speech mode got 5.3% of words wrong, Parakeet 3.8%, and Apple’s dictation mode 8.4%. On everyday journaling (clips 1, 2, 4, and 5), Apple and Parakeet came out within one error of each other (20 and 21 in 758 words). Parakeet did better on names and numbers, which is where Apple’s engine gives up the most.
- **Speed**: Apple’s first words took about 1.0s and settled about 1.5s after a pause. Its grey text almost never rewrote itself. Without fast results, SpeechTranscriber works in windows of about 4s, and text shows about 3.5s late.
- **Cost**: Parakeet through sherpa-onnx took about 380 ms to read a 15s phrase, over the 300 ms limit. Its memory reached 1.8 to 2.3 GB, over the 1.5 GB limit with a chat model loaded. It would also add a download of about 480 MB.
- **Silence**: neither engine invented words during long silences.
- **Resampling**: the Native SDK turns 48 kHz audio into 16 kHz without a filter. That cost at most 0.4 points of word errors, so Sage asks the SDK for 16 kHz directly.

## Tidy

Tidy cleans up spoken text with the summary model, the one Dream uses. It fixes run-on sentences, adds paragraph breaks, and removes fillers, repeats, and false starts. It keeps your words, your first person, and your meaning. Nothing leaves this Mac, because the model runs in the local Ollama server.

Tidy shows in two places:

- **After Stop**: a **Tidy** button in the entry header cleans the stretch you dictated last. It stays until you type or leave the entry.
- **In the selection menu**: select text and choose **Tidy**. It is off, with a tooltip, when the selection holds anything but plain paragraphs, such as a heading, a list, or bold text.

The spinner reads “Tidying…”. The result replaces the text as paragraphs, in one undo step, and the header offers **Keep** and **Undo**. Undo restores the original text. Typing, leaving, and Esc count as Keep. If you change the text while Tidy works, Sage drops the result and says so.

These limits apply:

- **Plain paragraphs only**: Tidy swaps the text for new paragraphs, which would lose a heading, list, or mark.
- **16 KiB**: a longer request answers “Select less text to tidy.”
- **It waits behind Dream**: Ollama answers requests for one model in turn, so Tidy waits while Dream uses the summary model. The wait counts toward a limit of 3 minutes, after which Tidy answers “Local AI did not answer in time.”
- **It refuses output that changes your words**: Sage compares the reply with the original. It must keep between 50% and 110% of the words, and at most 5% of its words can be new. Otherwise Tidy answers “Tidy would have changed your words, so Sage left them as they were.”

`journal.tidy` also answers “Local AI is not running.” and the summary-model-not-downloaded message. In the first case, the toast offers **Start local AI**. A Tidy that finishes after Sage locks answers “Sage is locked.” and the text is dropped. The code is `tidy` in `src/ollama.zig` and `handleJournalTidy` in `src/main.zig`.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.” except `dictation.stop`, which always answers.

- `dictation.status`: whether this Mac can dictate, the microphone and model state, and the running session
- `dictation.start`: opens the mic and answers with the session number
- `dictation.stop`: stops a session, with `{ session, discard }`
- `dictation.openSettings`: opens Privacy & Security > Microphone
- `dictation.downloadModel`: starts the speech model download, and `dictation.status` reports its progress
- `journal.tidy`: cleans up the text it is given, and answers with the new text

`dictation.status` answers with this shape:

```ts
{
  available: boolean; // false hides the mic
  reason: "unsupported_os" | "engine_missing" | null;
  microphone: "granted" | "denied" | "restricted" | "undetermined";
  model: {
    state: "installed" | "missing" | "downloading" | "failed";
    fraction: number | null; // 0 to 1 while downloading
    message: string | null; // why a download failed
  };
  session: number | null; // stays set until dictation:stopped
}
```

`dictation.start` refuses with an error name that the web view reads as the error code:

- `Locked` and `Securing`: Sage is locked, or still securing the journal
- `DictationUnavailable`: the Mac is older than macOS 26, or the speech library is missing
- `SpeechModelMissing`: the model is not installed yet
- `MicrophoneDenied`: you refused access, or an administrator restricted it
- `DictationBusy`: the last session is still ending

A session ends within about 0.1s of a stop, but the core refuses a new one until it has ended. The web view keeps the mic off until then.

`dictation.stop` with `discard: false` is Stop, ⌘D, and Esc. With `discard: true` it cancels at once and sends no more text, which is how leaving works. A session that does not exist is ignored.

## Window events

The core sends three events to the web view. Names stay under 64 bytes, and each payload stays under 8 KiB.

- `dictation:started` with `{ session }`: the mic is on, and the button switches from Starting to Listening. If you stop before this, it is not sent.
- `dictation:text` with `{ session, seq, final, volatile }`: `final` is the text that settled since the last event, and `volatile` is the whole grey tail now. It replaces the one before it. `seq` starts at 1 for each session and rises by 1, so a gap means an event was lost, and the web view says so.
- `dictation:stopped` with `{ session, reason, message }`: the reasons are in [What stops dictation](#what-stops-dictation). `message` has words only for `denied`, `no_input`, `input_lost`, and `engine_failed`.

A phrase moves from grey to final inside one event, so grey words never vanish before their text appears. A long final is cut into slices of up to 2 KiB at UTF-8 boundaries, and only the last slice carries the grey tail. Control characters and invalid UTF-8 become spaces. The core sends no dictation events while Sage is locked, and it stops the session before the lock engages.

`dictation.start` answers before `dictation:started` or the first text arrives. The web view also asks `dictation.status` every 3 seconds while the mic is on and the window is visible. If two checks in a row show no session, it treats the session as ended with `engine_failed`.

## Threads

Audio passes through five steps, on four kinds of thread:

1. **Audio tap**: the Native SDK calls `captureSink` on its capture thread. The sink copies the samples into a ring of about 60s and sets a few flags. It takes no lock, allocates nothing, and never wakes the loop.
2. **Worker**: one thread per session drains the ring every 20 ms into the engine, up to 100 ms of sound at a time. It also ends the session when no sound arrives for 2s or the ring fills, and it settles the engine on a normal stop.
3. **Result queue**: the engine reports text from its own threads. Each report goes into a queue under a short spin lock, and wakes the loop thread. A newer grey tail replaces one that is still queued.
4. **Loop thread**: `.effects_wake` drains the queue and builds the window events. A result from a session that is no longer current is dropped here. Only this thread starts and stops sessions, and nothing here touches SQLite.
5. **Window events**: `runtime.emitWindowEvent` sends them to the web view.

Tidy is a different path. It runs as a `tidy` job on the same queue as embeddings, in a worker thread that calls Ollama, as [Architecture](architecture.md#threads) explains.

## The speech library

SpeechAnalyzer is Swift only and starts at macOS 26, while Sage runs on macOS 11 and later. So the engine is a separate library, `libSageSpeech.dylib`, built from `src/speech/SageSpeech.swift`. The Sage executable never links it. `src/speech_apple.zig` opens it at run time with `std.DynLib`, which is why the Speech framework and the Swift runtime do not appear in the executable’s load commands.

The library has a small C interface: `sage_speech_status`, `_install`, `_begin`, `_feed`, `_finish`, `_cancel`, and `_free`, plus an ABI version that Sage checks. Where Sage finds the library follows where its executable sits, as with the bundled Ollama:

- **A packaged app** loads `Contents/Frameworks/libSageSpeech.dylib` and ignores the environment variable below.
- **Any other launch** loads the absolute path in `SAGE_SPEECH_LIB_PATH`. `make dev` sets it to `zig-out/lib/libSageSpeech.dylib`, where the build installs the library.

If the file is missing, `dictation.status` answers `engine_missing`, and Settings says “Sage’s dictation files are missing. Reinstall Sage.” If the file is there but macOS refuses to load it because the Mac is older than macOS 26, the answer is `unsupported_os`, and Settings says “Dictation needs macOS 26 or later.”

`build.zig` builds the library with `xcrun swiftc` for macOS 26 and installs it in `zig-out/lib/`. `make package` copies it into the app before signing.

Building it needs the macOS 26 SDK, which Xcode 26 includes. Pass `-Dspeech=false` to skip it on a Mac without that SDK, and Sage then has no mic. `native check` and `native test` do not build it. The release workflow runs on `macos-26`, because packaging builds it.

After a macOS update, check that the engine still works. A live test in `src/speech_apple.zig` feeds a recorded clip through the real engine and the whole core. It is skipped unless `SAGE_SPEECH_LIB_PATH` names a built library and `SAGE_SPEECH_TEST_WAV` names a 16 kHz mono 16-bit WAV file. `SAGE_SPEECH_TEST_SECONDS` limits how much of the file it reads.

macOS can add its own **Start Dictation…** item to the Edit menu. It is a separate feature of macOS, and Sage does not control it.
