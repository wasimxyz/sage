# Models

This page explains which Ollama models Sage uses, how Settings > Models recommends, downloads, and deletes them, and what happens when Ollama is not running. The screen is `frontend/src/components/settings-models.tsx`, and the Ollama client is `src/ollama.zig`.

## Which models Sage uses

Sage uses three kinds of model, all served by Ollama on this Mac:

- **Chat model**: the model you pick in Chat. A new chat starts with your last choice, then `qwen3.5:9b` if it is pulled, then the first listed chat model.
- **Summary model**: the model Dream uses for summaries, titles, and memories. The default is `qwen3.5:9b`, and `SAGE_SUMMARY_MODEL` changes it.
- **Embedding model**: any pulled tag of `nomic-embed-text`. `SAGE_EMBED_MODEL` changes the name Sage looks for.

Sage skips any model Ollama marks as cloud-hosted, and the Chat agent refuses one even if a request names it. The Chat picker also leaves out the embedding model.

## Settings > Models

Settings > Models has two tables:

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
- **Delete**: `ollama.delete` removes the model from Ollama.

The Installed table reloads when a download finishes.

## When Ollama is not running

Chat and Settings > Models show a notice with a Start Ollama button. Settings > Models also says to start Ollama before you download or delete models. The sidebar Dream button turns off, as [Dream](dream.md#when-dream-cannot-run) explains.

Start Ollama calls `ollama.start`:

1. The core opens the Ollama app through LaunchServices.
2. If only the command line tool is installed, it runs `ollama serve` instead.
3. It answers once `/api/tags` replies.

While the call runs, the notice reads Starting Ollama… and the button reads Starting…. If the start fails, the notice shows the reason and the button comes back.

Chat checks `embeddings.status` every 4 seconds to see whether Ollama is running. When Ollama comes up, Chat reloads its model list and Settings > Models reloads its Installed table.

## Bridge commands

While Sage is locked, every command below answers “Sage is locked.”

- `ollama.models`: pulled chat models, without the embedding model or cloud models
- `ollama.pull`, `ollama.pulls`, and `ollama.pullCancel`: start a download, report its progress, and cancel it
- `ollama.delete`: removes one model
- `ollama.start`: starts Ollama and answers once it replies
- `system.hardware`: the chip name, memory size, and CPU core count
