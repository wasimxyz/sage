# Eval suite

This page explains how to grade Sage’s Dream and Chat against a local dataset with `make eval`. The cases live under `agent/evals/data/`, and the eval files live in `agent/evals/`.

The suite seeds Markdown journal entries into a throwaway copy of Sage, runs Dream, then grades the extracted facts and events, the summaries, journal search, and Chat replies. The runner builds Sage with memory on, because normal builds leave it off. Results are JUnit XML files under `agent/evals/reports/`, which [Eval reports](evals-reports.md) explains.

## What the suite grades

Each eval file turns part of a case’s `case.yaml` into checks. A hard check fails the test, while a soft check or a judge score is recorded without failing it.

- **Extraction** (`extraction.eval.ts`): searches memory for each `facts` and `events` reference. Hard checks: memory returns something, and each event’s `sourceId` matches the seeded entry. The judge scores whether the result matches the reference, and a fact with a `stale` key soft-checks that the current wording ranks above the old one.
- **Summaries** (`summaries.eval.ts`): reads the full summary from `entry_summary` in the throwaway SQLite file. Hard check: a summary exists. The judge scores it against the reference, and an encrypted row fails the eval.
- **Retrieval** (`retrieval.eval.ts`): sends each `retrieval` query to journal search. Hard check: the expected entry is the top hit. There is no judge.
- **Chat** (`chat.eval.ts`): sends each `chat` question to the agent, and `chat-judge.eval.ts` later scores the saved reply against the reference. Hard check: the turn finishes. With `expectTool: true`, a soft check looks for a `search_journal` or `facts__search_memories` call.

Judge scores are tracked data, not merge blockers. Use the hard checks to tell whether a run is broken, and compare judge scores across runs.

## What you need

- Ollama running at `http://127.0.0.1:11434`
- The models the run uses. The defaults are `qwen3.5:9b` for Dream, Chat, and the judge, and `nomic-embed-text` for embeddings. The runner pulls any that are missing.
- Node.js 24 and the Native SDK CLI, the same tools `make dev` uses

## Running the suite

```sh
make eval
make eval ARGS='--tag example'
```

`ARGS` passes filters and other options to `eve eval`, and `--tag example` runs only the Sam format template. Do not pass `--url`, because `make eval` sets it to the local server that checks the Sage token.

## What a run does

The runner builds an automation copy of Sage under `zig-out/eval` and deletes it on exit, so `zig-out/bin/Sage` stays the `make build` binary. The copy runs from a temporary data directory. Its automation folder is separate from the one `make dev` uses.

For each trio of summary, embedding, and chat models, the runner:

1. Seeds `agent/evals/data/` into the throwaway journal and waits for Dream, or reuses a cached Dream result.
2. Starts a headless eve server for the trio.
3. Runs the Chat turns (`eve eval chat`) and saves each reply to a temporary file.
4. Embeds every eval search query in one batch (`eve eval embeddings`), then unloads the embedding model.
5. Scores the saved replies and runs extraction, summaries, and retrieval (`eve eval chat-judge extraction summaries retrieval`).
6. Merges the results into one JUnit file and joins each Chat reply to its score.

Each pass runs one eval at a time (`--max-concurrency 1`), because local models cannot share the GPU well. The order loads each model once: the chat model in step 3, the embedding model in step 4, and the judge in step 5.

Search in step 5 uses the saved query vectors, so it does not load the embedding model. If step 4 was skipped or failed, search embeds each query live instead. Tool calls during step 3 also embed live.

Each eval has a ten-minute timeout. Only `make eval` saves transcripts and joins Chat scores into the JUnit file, so a bare `eve eval chat` runs only the hard check. [Eval suite internals](../../agent/evals/README.md) lists every runner step.

## The eval server and its token

`eve eval` sends `EVE_EVAL_AUTH_TOKEN` only to a URL target, and for a local target it starts its own server with no token. So the runner starts a server for each trio and points every pass at it:

1. It starts `eve dev --no-ui --no-default-extensions --host 127.0.0.1 --port 0` with `SAGE_DISCOVERY_FILE` set to the throwaway `agent-server.json`.
2. It waits on `GET /eve/v1/health`, which is public and needs no token.
3. It reads `token` from that file and passes `--url http://127.0.0.1:<port>` and the token to each `eve eval` command.

The token is never printed and never comes from `agent/.env`. Each trio stops its server when it stops the throwaway Sage. A bare `npm --prefix agent run eval` runs a local `eve eval` and gets 401.

## The Dream cache

After Dream finishes, the runner copies the throwaway SQLite file and the journal-id manifest into `agent/evals/.cache/dream/`. The next run with the same inputs copies that snapshot back and skips seeding and Dream.

The folder name is a hash of these inputs:

- The eval dataset under `agent/evals/data/`, including every `case.yaml`
- The summary and embedding model names and their Ollama digests
- The Dream source files: `src/dream.zig`, `src/ollama.zig`, `src/journal.zig`, and `src/schema/*.sql`

Chat and judge models do not affect the cache. To skip it for one run, use `SAGE_EVAL_CACHE=0 make eval`. To delete it, run `rm -rf agent/evals/.cache`.

## Comparing models

Set comma-separated lists in `SAGE_SUMMARY_MODELS`, `SAGE_EMBED_MODELS`, and `SAGE_CHAT_MODELS` to run every combination. Each trio writes its own JUnit file, Sage log, and manifest. The runner sets `x-sage-model` from that trio’s chat model.

A failed trio does not stop the sweep, and the runner exits non-zero at the end if any trio failed. Dream snapshots depend only on the summary and embedding models, so extra chat models reuse the cache.

## Environment

`make eval` and `make eval-upload` load `agent/.env`, then `agent/.env.local`. A variable already set in the shell keeps its value. Copy `agent/.env.example` to `agent/.env.local` to save a sweep there.

| Variable | Default | Role |
| --- | --- | --- |
| `SAGE_SUMMARY_MODEL` / `SAGE_SUMMARY_MODELS` | `qwen3.5:9b` | Dream summary and extraction model (comma-separated for a sweep) |
| `SAGE_EMBED_MODEL` / `SAGE_EMBED_MODELS` | `nomic-embed-text` | Embedding model prefix |
| `SAGE_CHAT_MODELS` | `SAGE_CHAT_MODEL`, then `OLLAMA_MODEL`, then `qwen3.5:9b` | Comma-separated chat models for `make eval` |
| `SAGE_CHAT_MODEL` | first entry of `SAGE_CHAT_MODELS`, then `OLLAMA_MODEL`, then `qwen3.5:9b` | Chat model for one run. Chat evals read this first |
| `SAGE_JUDGE_MODEL` | `qwen3.5:9b` | Model that scores summaries and answers |
| `OLLAMA_BASE_URL` | `http://localhost:11434/api` | Ollama native API prefix |
| `SAGE_EVAL_CACHE` | on (`0` skips) | Reuse a previous Dream snapshot when the dataset and models match |
| `SAGE_EVAL_CACHE_DIR` | `agent/evals/.cache/dream` | Folder that stores Dream snapshots |

Each trio sets both `SAGE_CHAT_MODEL` and `OLLAMA_MODEL` to its one chat model before `eve eval`. If you run `eve eval` yourself with the two set differently, Chat uses `SAGE_CHAT_MODEL`.

The runner sets `SAGE_DATA_DIR`, `SAGE_DISCOVERY_FILE`, and `SAGE_AUTOMATION_CWD`, so do not point them at your real journal. It also sets `EVE_EVAL_AUTH_TOKEN` for the `eve eval` processes only, from the token in `SAGE_DISCOVERY_FILE`. You never set that token yourself.

## Uploading reports

After a run, `make eval` asks whether to upload the files in `agent/evals/reports/` to a [Vercel Blob](https://vercel.com/docs/vercel-blob) store. The default is no. To upload reports from earlier runs:

```sh
make eval-upload
```

That command is safe to repeat. Each file is stored as `sage-evals/<filename>`, and a file whose name already exists is skipped.

Set `BLOB_READ_WRITE_TOKEN` in the shell, in `agent/.env`, or in `agent/.env.local`. A linked Vercel project can use `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` instead, the short-lived token that `vercel env pull` writes. Reports are private unless you set `SAGE_EVAL_BLOB_ACCESS=public`.

The [eval viewer](../../eval-viewer/README.md) lists uploaded reports.

## Your first run

Run `make eval ARGS='--tag example'` on a Mac that already has Ollama and the models above. The Sam timeline is only a format template, so use its report to learn the format, not to judge quality. Then add your own cases under `agent/evals/data/`, as [Eval fixtures](../../agent/evals/data/README.md) explains.

## Unit tests

The fixture unit tests need no Ollama and run as part of `make test`. To run only those, use `npm --prefix agent run test:evals`. The dev-terminal auth hook has its own tests: `npm --prefix agent run test:scripts`.
