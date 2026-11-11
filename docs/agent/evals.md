# Eval suite

This page explains how to grade Sage’s Dream and Chat with `make eval`. The suite seeds made-up people into throwaway journals, runs Dream, asks Chat questions, and grades what comes back. A cloud model judges the answers, so a run needs a key and spends money. The people live under `agent/evals/data/`, the sweep files under `agent/evals/sweeps/`, and the eval files in `agent/evals/`.

Results are JSON reports under `agent/evals/reports/`, which [Eval reports](evals-reports.md) explains.

## Terms

- **Person**: one made-up author. A person is a folder of Markdown journal entries plus a `case.yaml` answer key, as [Eval fixtures](../../agent/evals/data/README.md) explains. Each person is seeded into their own throwaway journal.
- **Sweep**: a YAML file in `agent/evals/sweeps/` that lists the values to try. The runner runs every combination.
- **Setup**: one combination of the summary, embedding, and chat models, the Dream and Chat prompts, thinking, context length, and memory build.
- **Hard check**: one failure fails the setup.
- **Counted check**: a rule whose failures are counted. Fewer is better. It never fails a setup by itself.
- **Soft check**: a check or judge score that is recorded and never fails anything.
- **Judge**: the cloud model that grades Sage’s output against the answer key.
- **Dream cache**: Dream’s results for one person, saved so the next run skips seeding and Dream.

## What the suite grades

Each eval file turns part of a person’s `case.yaml` into checks. A run has three passes. The person pass checks what Dream wrote. The chat pass sends each Chat question to the agent. The grade pass sends the saved replies to the judge.

- **Extraction** (`person/extraction.eval.ts`): searches memory for each `facts` and `events` reference. Counted checks: memory returns something, and each event’s `sourceId` matches the seeded entry. Soft checks: the judge scores whether the result matches the reference. A fact with a `stale` key also gets a judge score for the current state, and a check that the current wording ranks above the old one. Memory-off setups skip all of these.
- **Summaries** (`person/summaries.eval.ts`): reads the summary from `entry_summary` in the throwaway SQLite file. Counted check: a summary exists. Soft check: the judge scores it against the reference. An encrypted row fails the eval.
- **Retrieval** (`person/retrieval.eval.ts`): sends each `retrieval` query to journal search. When a case sets `when`, the search covers only that time. Counted check: the expected entry is the top hit. Soft check: a score of 1 divided by the entry’s rank. There is no judge.
- **Chat facts** (`chat/facts.eval.ts`, graded by `grade/facts.eval.ts`): sends each `chat` question to the agent, and the grade pass scores the saved reply against the reference. Counted check: the turn works. With `expectTool: true`, a soft check looks for a `search_journal` call, or a `facts__search_memories` call when memory is on. With `expectWhen: true`, a soft check looks for a `search_journal` call that passed `when`.

One hard check covers a whole setup. **Fast enough** fails the setup when the median wait for the first visible word of Chat’s replies is over `speedLimitSeconds`, 20 by default. Thinking time and tool time count. Set `p90LimitSeconds` to limit the slowest 10% too. The sweep file also takes `maxSwapGrowthMB`, a limit on memory swap, but the runner does not measure swap yet, so that limit never fails a setup.

Openers, conversations, and Dream accuracy checks are not part of the suite yet. A sweep can name them in `tests`, and the runner lists the eval files it cannot find.

Judge scores are tracked data, not merge blockers. Use the hard and counted checks to tell whether a run is broken, and compare judge scores across runs.

## What you need

- Node.js 24 and the Native SDK CLI, the same tools `make dev` uses
- No separate Ollama install. The runner uses the pinned copy that `scripts/fetch-ollama.sh` downloads. It stops if port 11436 is already in use, which `make dev` also uses, so stop `make dev` before an eval.
- The models the sweep names. The shipped sweeps use `qwen3.5:9b` for Dream and Chat, and `nomic-embed-text` for embeddings. The runner pulls any that are missing, after you confirm.
- A Vercel AI Gateway credential for the judge, and a network connection

## The cloud judge

The judge is `moonshotai/kimi-k3.1-pro`, reached through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). To use another model, set `judge: { model: <gateway model id> }` in the sweep file.

Set one credential in `agent/.env.local` or in your shell:

- `AI_GATEWAY_API_KEY`: an AI Gateway API key
- `VERCEL_OIDC_TOKEN`: the short-lived token that `vercel env pull` writes. Use an API key for a long sweep.

With neither, the runner prints “No AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set” and exits with code 2. A `--dry-run` prints the same message and carries on.

Only evals use these keys. The runner hands them to the `eve eval` processes that call the judge and to nothing else: not Sage, not `eve dev`, not Ollama. Chat never reaches a cloud model.

The judge sees only the made-up people under `agent/evals/data/`. Each call carries the person’s `about` text, fact sheet, and full journal, plus the reference and the output being graded. Never put a real journal entry, chat, or memory in that folder, and never point the suite at your real data.

Each call is one structured request with temperature 0 and at most 8,192 output tokens. The gateway tags it `sage-eval` and the sweep id. A judge error marks the item “not graded”. It never counts as a failure.

## Running the suite

```sh
make eval ARGS='--dry-run'
make eval SWEEP=smoke
make eval
make eval ARGS='--tag example'
```

`SWEEP` picks a file from `agent/evals/sweeps/`, and the default is `default`. `ARGS` carries runner options and filters for `eve eval`:

- `--dry-run`: plans the sweep, builds the Chat prompt overlays, checks the models, starts the grade target, and prints the estimate. It runs no models, pulls nothing, and builds no Sage. It still downloads the pinned Ollama if you do not have it yet.
- `--yes`: skips the “Continue? [y/N]” question. Without a terminal, the runner stops with exit code 2 unless you pass it.
- `--tag <tag>`: runs only evals with this tag, and repeats for more tags. An eval carries its person’s tags and its kind: `extraction`, `summaries`, `retrieval`, or `chat`. `--tag example` runs only the Sam format template.
- `--exclude-tag <tag>`: skips evals with this tag
- `--timeout <ms>`: the time each eval gets. The default is ten minutes.
- `--strict`, `--verbose`, `--skip-report`: passed to `eve eval` as they are
- `--help`: prints the usage

Do not pass `--url`, `--max-concurrency`, `--json`, `--junit`, or `--list`. The runner sets them, and it refuses them with exit code 2. Filters apply to every `eve eval` process, but they change neither the people the sweep covers nor the estimate.

## Sweep files

A sweep file lists the values to try, and the runner runs every combination as a setup. Two files ship:

- `default.yaml`: today’s models (`qwen3.5:9b` and `nomic-embed-text`), the `person` and `facts` tests, and memory off and on
- `smoke.yaml`: a check of the runner. One setup with memory on, only the Sam format template (`tags: [example]`), and a $1 spending cap.

Every key is optional. An unknown key or a value of the wrong type stops the run with a message that names the file and the key.

| Key | Default | What it sets |
| --- | --- | --- |
| `summaryModels` | `[qwen3.5:9b]` | Dream’s summary and extraction models |
| `embedModels` | `[nomic-embed-text]` | Embedding models |
| `dreamPrompts` | `[baseline]` | Dream prompts. `baseline` is the built-in prompts, and no other value works yet. |
| `prompts` | `[baseline]` | Chat prompts, as [Chat prompts](#chat-prompts) explains |
| `chatModels` | `[qwen3.5:9b]` | Chat models |
| `thinking` | `[off]` | `off` or `on`. Levels such as `high` parse, but the runner refuses them. |
| `contextLengths` | `[32768]` | Context lengths in tokens |
| `memory` | `[off]` | `off` or `on`, the memory build, as [Memory off and on](#memory-off-and-on) explains |
| `repeats` | `1` | How many times each Chat question runs |
| `tests` | `[person, facts]` | Which tests run: `person` (extraction, summaries, retrieval) and `facts` (Chat facts) |
| `tags` | `[]` | The people to cover. A person is in when their `tags` match. With no tags, every person is in. |
| `judge` | `{ model: moonshotai/kimi-k3.1-pro }` | The judge model |
| `speedLimitSeconds` | `20` | The limit for the median first-word wait |
| `p90LimitSeconds` | `null` | A limit for the slowest 10%. `null` sets none. |
| `spendingCapUsd` | `50` | The most the sweep may spend on cloud calls |

`maxSwapGrowthMB`, `maxToolCallsPerTurn`, `replyWords`, and `simulatedUser` are accepted and written to the report, but no check uses them yet.

To replace a model list for one run, set a comma-separated variable. It wins over the sweep file:

```sh
SAGE_CHAT_MODELS=qwen3.5:9b,qwen3:14b make eval SWEEP=smoke
```

`SAGE_SUMMARY_MODELS`, `SAGE_EMBED_MODELS`, and `SAGE_CHAT_MODELS` replace `summaryModels`, `embedModels`, and `chatModels`. The runner prints which lists it replaced. A leading `ollama/` is dropped.

A setup has a stable 10-character id that does not depend on key order. The runner loops over the values in this order: memory, summary model, embedding model, Dream prompt, person, Chat prompt, chat model, context length, thinking. The outer values restart Sage. The inner ones only change what Chat asks for.

## What a run does

The runner works in stages and prints a heading for each one:

1. **Plan.** It reads the sweep file and loads every person. It checks the data: an entry dated after 2026-11-15, a reference that matches no entry, or a `when` phrase that does not cover its entry. It picks the people the sweep’s `tags` cover, maps `tests` to eval files, and prints how many Sage starts, Chat server starts, and model loads the plan needs.
2. **Chat prompts and grade target.** It builds one app root for each Chat prompt and a stub target, checks each with `eve info --json`, and starts the stub target.
3. **Models and estimate.** It fetches the pinned Ollama and starts a temporary Ollama server on `127.0.0.1:11436`. It asks the server about each model and lists the ones that are not pulled yet. It stops on a chat model that cannot call tools, and on a summary or embedding model that cannot complete or embed. It skips think-on setups for models that cannot think. Then it prints [the estimate](#the-estimate-and-the-spending-cap). `--dry-run` ends here.
4. **Key and question.** Without a gateway key, the run stops with exit code 2. Then it asks “Continue? [y/N]”, unless you passed `--yes`.
5. **Pull.** It pulls each missing model through the temporary server, then stops the server so Sage can use the port.
6. **Build.** It builds Sage with automation once for each memory value, under `zig-out/eval-mem0` (memory off) and `zig-out/eval-mem1` (memory on). `zig-out/bin/Sage` stays the `make build` binary, and the runner deletes both builds on exit.
7. **Judge check.** The runner prints that the judge check is not part of it yet, and the sweep goes on.
8. **Run.** It runs one unit for each person, as the next list explains.
9. **Reports.** It writes the reports, prints the ranking and the real hours and cost, and runs `scripts/eval-upload.sh` to ask about an upload.

A unit is one person under one Dream snapshot. For each unit, the runner:

1. Lists the evals each pass would run, and skips the unit when the filters match none.
2. Makes a throwaway data directory with a stub frontend and a link to `app.json`, and copies in the Dream cache when it has one.
3. Starts the Sage build from that directory. Sage starts its own Ollama on `127.0.0.1:11436` from `SAGE_OLLAMA_PATH`, because it is not in an app bundle.
4. On a cache miss, seeds the person’s entries through the bridge (`agent/scripts/seed-dataset.ts`), waits for Dream, and saves the result to the cache. A person with no entries has nothing for Dream to read.
5. Unloads the summary model and runs the person pass (`eve eval person/extraction person/summaries person/retrieval`).
6. For each Chat prompt, starts a Chat server from that prompt’s app root. For each setup, it loads the chat model at the context length, unloads the one before it, runs the chat pass (`eve eval chat/facts`), and hands the grade pass (`eve eval grade/facts`) to a background pool.
7. Stops Sage, copies its log and manifest to `agent/evals/reports/`, and waits for its Ollama to exit.

Each person gets a new Sage and a new Ollama, so a model loads again for each person. Person and chat evals run one at a time (`--max-concurrency 1`), because local models cannot share the GPU well. Grade evals run four at a time, in at most two processes, so grading one setup overlaps with generating the next. The throwaway data directory stays until the last grade job for the unit is done.

A unit that fails is recorded and does not stop the sweep. The runner lists the problems at the end and exits with code 1. It also exits with 1 when an eval fails. Press Ctrl-C once to stop the processes the runner started, and press it again to quit at once.

## The estimate and the spending cap

Before it asks, the runner prints an estimate with these lines:

- **Dream**: the runs the cache cannot answer, and their hours. The default is 30 seconds per entry with memory off and 60 with memory on.
- **Person checks**: the hours for extraction, summaries, and retrieval
- **Chat**: the hours of replies. The time per reply comes from the newest report for that chat model in `agent/evals/reports/`. Without one, it is 25 seconds with thinking off and 60 with it on.
- **Setup**: the hours for builds, Sage starts, Chat server starts, and model loads
- **Cloud**: the dollars for the judge, from the token counts of each call and AI Gateway’s public price list. When the list has no price for a model, the estimate uses a default price and says so.

The estimate ignores filters in `ARGS`, so a filtered run costs less than it shows. When the estimate is over `spendingCapUsd`, the runner warns you before it asks.

Every judge call reserves its worst-case cost in a ledger (`ledger.jsonl` in the run folder) before it runs, and writes the real cost after. Past the cap, the call does not run and the item is marked “not graded: spending cap”. At the end, the runner prints the real hours and dollars next to the estimate.

## Chat prompts

A Chat prompt is the `instructions.md` that Chat runs with. The runner never edits `agent/agent/`, and shipped code never reads a prompt setting. Instead, it builds `agent/.eval-roots/<prompt>/` for each prompt in the sweep: a copy of `agent/package.json`, `tsconfig.json`, and `agent/agent/`, with `instructions.md` replaced.

- `baseline` copies the live `instructions.md`, so every prompt runs under the same conditions.
- Any other name is a file at `agent/evals/prompts/<name>.md`. No prompt files ship yet, so `baseline` is the only prompt until you add one.
- The `instructions/` folder (memory, profile, today, and user) stays as it is.
- `eve info --json` must report each root as ready, with every tool the live agent has.

The folder `agent/.eval-roots/` is ignored by git. It also holds `_target`, the stub grade target.

## The eval server and its token

`eve eval` sends `EVE_EVAL_AUTH_TOKEN` only to a URL target, and for a local target it starts its own server with no token. So the runner starts the servers and points every pass at one with `--url`.

For each Chat prompt of a unit, the runner:

1. Starts `eve dev --no-ui --no-default-extensions --host 127.0.0.1 --port 0` from the prompt’s app root, with `SAGE_DISCOVERY_FILE` set to the throwaway `agent-server.json`. The server loads the workflow guard, and eve picks a free port.
2. Waits on `GET /eve/v1/health`, which is public and needs no token.
3. Reads `token` from that file and sends it to the chat pass, through `EVE_EVAL_AUTH_TOKEN`.

The person and grade passes never send a message. They point at a stub app named `sage-agent`, built in `agent/.eval-roots/_target/` with a mock model. It starts once per sweep and carries no token. The person pass reads Sage’s local agent server directly, through the same discovery file.

The runner never prints the token and never reads it from `agent/.env`. It replaces the token with `[redacted]` in logs and console output. Each Chat server stops when its prompt’s setups are done. A bare `npm --prefix agent run eval` runs a local `eve eval` with no token, and Chat turns get 401.

## The Dream cache

After Dream finishes, the runner copies the throwaway SQLite file and the journal-id manifest into `agent/evals/.cache/dream/<key>/`. The next run with the same inputs copies that snapshot back and skips seeding and Dream. Each person has their own snapshot, so editing one person’s entries runs Dream again for that person only.

The folder name is a hash of these inputs:

- The person’s `*.md` entries, and any files in their `chats/` folder
- The summary and embedding model names and their Ollama digests
- The Dream prompt text, or a marker for the built-in prompts
- The memory value, off or on
- The Dream source files: `src/dream.zig`, `src/ollama.zig`, `src/journal.zig`, and `src/schema/*.sql`

Chat settings and the judge do not affect the cache, and neither does `case.yaml`, so editing a check does not run Dream again. To skip the cache for one run, use `SAGE_EVAL_CACHE=0 make eval`. To delete it, run `rm -rf agent/evals/.cache`.

## Memory off and on

Normal builds leave memory off, so the runner builds Sage once for each `memory` value in the sweep. `default.yaml` runs both so the memory checks keep running, and `smoke.yaml` runs memory on.

- With memory off, Dream writes no facts, events, or profile, and Chat has no `facts__search_memories` tool. The extraction evals skip with “Memory is off in this setup”, and the report counts them as skipped, not failed.
- Summaries, retrieval, and Chat facts run with either build. A Chat search check counts `facts__search_memories` only when memory is on.
- The memory value is part of the Dream cache key, so each build has its own snapshots. [Memories](memories.md) explains the feature.

## Environment

`make eval` and `make eval-upload` load `agent/.env`, then `agent/.env.local`. A variable already set in the shell keeps its value. Copy `agent/.env.example` to `agent/.env.local` to save settings there.

| Variable | Default | Role |
| --- | --- | --- |
| `SAGE_SUMMARY_MODELS` | the sweep file’s list | Comma-separated list that replaces `summaryModels` |
| `SAGE_EMBED_MODELS` | the sweep file’s list | Comma-separated list that replaces `embedModels` |
| `SAGE_CHAT_MODELS` | the sweep file’s list | Comma-separated list that replaces `chatModels` |
| `AI_GATEWAY_API_KEY` | none | AI Gateway key for the judge |
| `VERCEL_OIDC_TOKEN` | none | Short-lived AI Gateway credential from `vercel env pull` |
| `SAGE_EVAL_CACHE` | on (`0` skips) | Reuse a previous Dream snapshot when the inputs match |
| `SAGE_EVAL_CACHE_DIR` | `agent/evals/.cache/dream` | Folder that stores Dream snapshots |

The sweep file picks the models, so `make eval` ignores `OLLAMA_MODEL`, `OLLAMA_CONTEXT_WINDOW`, and `OLLAMA_BASE_URL`. It always uses the Ollama on `127.0.0.1:11436`.

The runner pins `SAGE_TODAY` to 2026-11-15, later than every entry, so phrases such as “in June” and “recently” read the same way on every run. You can’t override it.

Sage gets only the values the runner sets for it. Any other `SAGE_` or `NATIVE_SDK_` variable in your shell is dropped, so a stray `SAGE_DATA_DIR` cannot point a run at your real journal. Every child process also loses any variable whose name looks like a credential. Only the `eve eval` processes get the gateway keys.

## Uploading reports

After a run that wrote reports, `make eval` asks whether to upload the files in `agent/evals/reports/` to a [Vercel Blob](https://vercel.com/docs/vercel-blob) store. The default is no. To upload reports from earlier runs:

```sh
make eval-upload
```

That command is safe to repeat. Each file is stored as `sage-evals/<filename>`, and a file whose name already exists is skipped.

Set `BLOB_READ_WRITE_TOKEN` in the shell, in `agent/.env`, or in `agent/.env.local`. A linked Vercel project can use `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` instead, the short-lived token that `vercel env pull` writes. Reports are private unless you set `SAGE_EVAL_BLOB_ACCESS=public`.

The [eval viewer](../../eval-viewer/README.md) lists uploaded reports.

## Your first run

1. Run `make eval ARGS='--dry-run'`. It needs no gateway key and runs no models. It shows the plan, the models you still need to pull, and the estimate.
2. Add `AI_GATEWAY_API_KEY` to `agent/.env.local`.
3. Run `make eval SWEEP=smoke` on a Mac with room for the models above. It grades only the Sam format template on one setup, for under $1. The first run also runs Dream, which takes the longest.
4. Read the report in [Eval reports](evals-reports.md). The Sam journal is a format template, so use its report to learn the format, not to judge quality.
5. Run `make eval`, then add your own people under `agent/evals/data/`, as [Eval fixtures](../../agent/evals/data/README.md) explains.

## Unit tests

The unit tests need no Ollama and no cloud key, and they run as part of `make test`. To run the tests for `agent/evals/lib/` alone, use `npm --prefix agent run test:evals`. To run the runner’s tests and the dev-terminal auth hook’s tests, use `npm --prefix agent run test:scripts`. [Eval suite internals](../../agent/evals/README.md) lists the modules they cover.
