# Eval suite internals

This page is for people changing the eval runner or the eval files. To run the suite, see [docs/agent/evals.md](../../docs/agent/evals.md). To write cases, see [data/README.md](data/README.md).

## The pipeline

`make eval` runs `scripts/eval-run.sh`. Once per summary × embed × chat model trio, the runner:

1. Loads `agent/.env`, then `agent/.env.local`, without replacing variables already set in the shell.
2. Checks that curl, ollama, native, and node are installed and that Ollama is serving.
3. Pulls any missing models.
4. Builds Sage with automation enabled under `zig-out/eval` (`native build -Dinstall-prefix="$root/zig-out/eval" -Dautomation=true`), leaving `zig-out/bin/Sage` alone.
5. Creates a temporary data directory with a stub frontend and a symlink to `app.json`.
6. Copies the cached Dream snapshot into the data directory when the cache key matches.
7. Starts the `zig-out/eval` Sage binary and waits for the agent server file and the automation folder.
8. On a cache miss, runs `agent/scripts/seed-dataset.ts`: it wipes the throwaway journal, saves every case entry through the bridge, writes the journal-id manifest, starts Dream, and waits for it to finish.
9. Snapshots the database and manifest into the cache.
10. Writes empty `chat-transcripts.jsonl`, `query-embeddings.jsonl`, and `eval-results.jsonl` in the temporary data directory.
11. Reads `token` from that throwaway `agent-server.json`, starts one headless server for the trio (`eve dev --no-ui --no-default-extensions --host 127.0.0.1 --port 0`, with `SAGE_DISCOVERY_FILE` set to the throwaway file), and waits for `GET /eve/v1/health` with no `Authorization` header. Health is public. Every pass below runs with `--url http://127.0.0.1:<port>` and with `EVE_EVAL_AUTH_TOKEN` set from the file, in the client process only.
12. Lists matching chat evals (`eve eval chat --list`). If that list is empty, it skips generation.
13. Generates matching chat turns (`eve eval chat`) and appends each reply to `chat-transcripts.jsonl`. Each finished eval is appended to `eval-results.jsonl`.
14. Lists matching embedding evals (`eve eval embeddings --list`). If that list is empty, it skips embedding.
15. Embeds every eval search query (`eve eval embeddings`) in one Ollama batch, writes `query-embeddings.jsonl` and an embeddings JUnit file, and unloads the embed model.
16. Judges the saved replies and runs extraction, summaries, and retrieval (`eve eval chat-judge extraction summaries retrieval`). Search sends the saved vectors, so this pass does not load the embed model. If the embedding pass was skipped or failed, search embeds live instead.
17. Merges the generate, embeddings, and judge JUnit files, stitches each Chat turn with its judge score into one `chat/…` case, and writes `agent/evals/reports/<run id>.xml`.
18. Copies the Sage log and manifest into `agent/evals/reports/`, stops the eval server, and deletes the data directory, including the transcripts, query embeddings, and result rows.

After all trios finish, the runner deletes `zig-out/eval`, and `scripts/eval-upload.sh` asks about uploading reports. The runner exits non-zero if any trio failed.

Dream cache keys leave out the chat model, so a later chat model with the same summary and embed models reuses the snapshot.

## The eval files

Each file in this directory turns `case.yaml` references into eve evals:

- `extraction.eval.ts`: facts and events against the memory search endpoints, with judge factuality scores
- `summaries.eval.ts`: entry summaries read from SQLite, scored by the judge
- `retrieval.eval.ts`: journal search queries with a hard top-hit check
- `chat.eval.ts`: Chat questions for the run’s chat model. Writes each reply to `chat-transcripts.jsonl` and checks that the turn finished. When the case asks, it also checks for a `search_journal` or `facts__search_memories` call
- `chat-judge.eval.ts`: judge factuality scores for the saved chat replies
- `embeddings.eval.ts`: one Ollama batch that embeds retrieval queries, fact and event references, and entry titles, then writes `query-embeddings.jsonl`
- `evals.config.ts`: the eve eval config: the judge model, sequential runs, a ten-minute per-test timeout, and the result recorder when `SAGE_EVAL_RESULTS` is set

## The helpers

`lib/` holds the code the eval files and scripts share:

- `bridge.ts`: parses bridge responses from the automation folder and chunks UTF-8 text for `journal.save`
- `cache.ts`: computes the Dream cache key and snapshots the database and manifest
- `dataset.ts`: loads cases from `data/`, parses frontmatter and `case.yaml`, and reads the journal-id manifest
- `junit.ts`: merges eve JUnit files and stitches Chat generate + judge rows into one `chat/…` case
- `models.ts`: resolves chat, summary, embed, and judge model names from the environment. `chatModel()` is the current run’s model (`SAGE_CHAT_MODEL` first), `chatModels()` is the sweep list, and `embedModel()` is `SAGE_EMBED_MODEL`.
- `query-embeddings.ts`: collects eval search strings, writes and loads `SAGE_EVAL_EMBEDDINGS`, and looks up a saved vector
- `rank.ts`: compares how current and stale fact wordings rank
- `recorder.ts`: appends finished eval results to `SAGE_EVAL_RESULTS`
- `sage.ts`: typed calls to the local agent server: journal search, fact and event search, and the profile
- `skip.ts`: a placeholder eval that skips itself when the dataset has no cases of a kind
- `store.ts`: reads entry summaries from the throwaway SQLite file
- `transcripts.ts`: appends and loads chat replies from `SAGE_EVAL_TRANSCRIPTS`
- `upload.ts`: lists report files and names their Vercel Blob pathnames

The scripts in `agent/scripts/` are the runner’s steps: `seed-dataset.ts` (seed and Dream), `eval-cache.ts` (cache key and snapshot commands), `merge-junit.ts` (combine the generate, embeddings, and judge JUnit files and stitch Chat scores), and `upload-eval-reports.ts` (the upload prompt). `scripts/eval-env.sh` loads `agent/.env` and `agent/.env.local` for `make eval` and `make eval-upload`. The other shell scripts in that folder are listed in [scripts/README.md](../../scripts/README.md).

The Next.js app in `eval-viewer/` reads the uploaded XML, Sage log, and manifest from Vercel Blob.

## Fixture unit tests

Every `lib/*.test.ts` file runs without Ollama as part of `make test`. To run only these: `npm --prefix agent run test:evals`.

`scripts/dev-auth-hook.test.ts` covers the dev-terminal auth hook: which URLs get Sage’s token, which keep the header eve built, and what happens before `agent-server.json` exists. It runs as part of `make test` too. To run it alone: `npm --prefix agent run test:scripts`.
