# Models

This page explains which Ollama models Sage uses, how Settings > Models recommends, downloads, and deletes them, and what happens when the Ollama server is not running. The screen is `frontend/src/components/settings-models.tsx`, and the Ollama client is `src/ollama.zig`.

## Which models Sage uses

Sage uses three kinds of model, all served by Ollama on this Mac:

- **Chat model**: the model you pick in Chat. A new chat starts with your last choice, then `qwen3.5:9b` if it is pulled, then the first listed chat model.
- **Summary model**: the model Dream uses for summaries, titles, and memories, and the one Tidy uses to clean up dictated text. The default is `qwen3.5:9b`, and `SAGE_SUMMARY_MODEL` changes it.
- **Embedding model**: any pulled tag of `nomic-embed-text`. `SAGE_EMBED_MODEL` changes the name Sage looks for.

Sage skips any model Ollama marks as cloud-hosted, and the Chat agent refuses one even if a request names it. The Chat picker also leaves out the embedding model.

Sage also skips the `llamacpp:` entries that Ollama’s llama.cpp runner lists beside a model. You did not pull them. If Ollama lists a name twice, Sage shows it once.

Dictation needs one more model, which is not an Ollama model. macOS provides the speech model, as [Dictation](dictation.md#the-engine) explains.

## Settings > Models

Settings > Models has three parts:

- **Speech**: the speech model for dictation. Its row reads Checking, Installed, Not downloaded, Downloading, or Download failed, and it has a Download or Try again button when macOS has no copy. Checking lasts a moment after Sage starts, until macOS says what is installed. macOS downloads and keeps the model, so Delete does not apply. A Mac that cannot dictate shows the reason in place of the row. The row comes from `dictation.status`, and **Download** calls `dictation.downloadModel`.
- **Installed**: the chat models Ollama has pulled, each with a Delete button
- **Recommended**: text models that should run well on this Mac, each with a Download button

The page reads the chip name and memory size through `system.hardware`, and its subtitle names them.

## How recommendations work

Recommendations come from canirun.ai grades saved in `frontend/src/lib/canirun-catalog.json`. Sage never contacts canirun.ai while it runs. Clicking a model name opens that model’s canirun.ai page in your browser.

A model appears under Recommended when it meets all of these:

- It has an Ollama tag and is a chat, code, or reasoning model.
- It has at least 6 billion parameters.
- Its grade for the closest matching Mac chip and memory size says it fits, with a score of at least 50.

The list is sorted by score, then by size, and capped at 25 models. To refresh the saved grades, run `npm --prefix frontend run catalog` and commit the new JSON.

## Downloading and deleting

- **Download**: `ollama.pull` starts a download. Only one download runs at a time, so the other Download buttons are off until it ends.
- **Progress**: the table shows progress from `ollama.pulls`, and Cancel calls `ollama.pullCancel`.
- **Delete**: `ollama.delete` removes the model from this Mac. The models folder is shared, so other apps that use it lose the model too. The dialog says so.

The Installed table reloads when a download finishes.

`ModelDownloadsProvider` owns the polling and the one-at-a-time rule for Settings > Models and for [First-launch setup](onboarding.md#the-downloads-screen). Setup queues the models it needs in the `onboarding.downloads` row, and the provider keeps downloading them after setup ends, after a restart, and after an unlock, until each model is ready or you cancel it. A download keeps running while Sage is locked. After an unlock or a refresh, the provider reads it back, so Settings > Models shows its progress again.

## When Ollama is not running

Chat and Settings > Models show a notice that says “Local AI isn’t running”, with a “Start local AI” button. Settings > Models also says to start local AI before you download or delete models. Clicking Dream in the sidebar opens a dialog with the same button, as [Dream](dream.md#when-dream-cannot-run) explains.

Start local AI calls `ollama.start`:

1. The core starts the bundled server, unless it is already running.
2. It answers once `/api/tags` replies. If that takes longer than 30s, the start fails.

While the call runs, the notice reads “Starting local AI…” and the button reads “Starting…”. If the start fails, the notice shows the reason and the button comes back. The reasons are:

- “Sage’s local AI files are missing. Reinstall Sage.” The app has no bundled copy of Ollama. Outside an app bundle, `SAGE_OLLAMA_PATH` names no binary.
- “Port 11435 is in use by another app.” Outside an app bundle, such as `make dev`, the port is 11436.
- “Local AI did not start in time.” When the server wrote a last log line, it follows the message.
- “Could not start local AI.” Any other failure.

`OllamaProvider` (`frontend/src/components/ollama-provider.tsx`) checks `embeddings.status` every 4s to see whether Ollama is running, then lists models with `ollama.models` when it is. While Sage is unlocked, the same check also restarts a server that has crashed, at most once every 10s. Chat, Dream, and Settings > Models all read this one check. A check that is still waiting on Ollama holds back the next one. A hidden window skips the check and runs it once when it comes back. When Ollama comes up, Chat reloads its model list and Settings > Models reloads its Installed table.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.”

- `ollama.models`: pulled chat models, each name once, without the embedding model, cloud models, or `llamacpp:` runner entries
- `ollama.pull`, `ollama.pulls`, and `ollama.pullCancel`: start a download, report its progress, and cancel it
- `ollama.delete`: removes one model
- `ollama.start`: starts the bundled server and answers once it replies
- `ollama.setupStatus`: whether the bundled Ollama is in the app and the server is running, and the embedding and summary model names, for [First-launch setup](onboarding.md#step-1-local-ai)
- `system.hardware`: the chip name, memory size, and CPU core count
