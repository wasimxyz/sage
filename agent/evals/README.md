# Eval suite internals

This page is for people changing the eval runner or the eval files. To run the suite, see [docs/agent/evals.md](../../docs/agent/evals.md). To read results, see [docs/agent/evals-reports.md](../../docs/agent/evals-reports.md). To write people, see [data/README.md](data/README.md).

## The runner

`make eval` runs `node --experimental-strip-types agent/scripts/eval/run.ts --sweep <name> <ARGS>`. `npm --prefix agent run sweep` runs the same entry point. `run.ts` parses the command line before anything else loads, so a bad option, including `--url`, stops there with exit code 2. The stages live in `runner.ts`.

One run does this:

1. `cli.ts` reads `--sweep`, `--dry-run`, `--yes`, and the eve filters. It refuses `--url` first, then the options the runner owns: `--json`, `--junit`, `--list`, and `--max-concurrency`.
2. `env.ts` loads `agent/.env`, then `agent/.env.local`, without replacing values the shell already set.
3. `sweep.ts` reads `agent/evals/sweeps/<name>.yaml`, applies `SAGE_SUMMARY_MODELS`, `SAGE_EMBED_MODELS`, and `SAGE_CHAT_MODELS`, and parses the file with `parseSweepFile`. It refuses thinking levels the agent cannot honor, expands the setups, and makes the sweep id.
4. `people.ts` loads the people through `lib/dataset.ts`, checks them with `validatePerson` as of 2026-11-15, and keeps the ones the sweep’s `tags` cover.
5. `plan.ts` maps `tests` to eval ids, groups the setups by Dream snapshot and by Chat prompt, and counts Sage starts, Chat server starts, and model loads. Test kinds with no eval file yet are reported, not run.
6. `overlay.ts` builds `agent/.eval-roots/<prompt>/` for each Chat prompt, and the stub `_target`. `eve info --json` must report each root as ready.
7. `eve.ts` starts `eve dev` on the stub target and waits for `GET /eve/v1/health`.
8. `ollama.ts` gets the pinned Ollama, starts a temporary server on `127.0.0.1:11436`, and asks `/api/show` about every model. It lists missing models, rejects a chat model with no tools, and notes the models that cannot think.
9. `estimate.ts` prints the hours and dollars, with prices from `cloud.ts`. `--dry-run` ends here.
10. The runner stops if no gateway key is set, and asks to continue unless `--yes` is set.
11. `ollama.ts` pulls the missing models, and the runner stops the temporary server.
12. `sage.ts` builds Sage once for each memory value: `native build -Dinstall-prefix=zig-out/eval-mem<0|1> -Dautomation=true -Dmemory=<false|true>`.
13. The judge check is a stub that passes. It arrives with the judge-check eval.
14. `unit.ts` runs one unit for each memory value, Dream snapshot, and person. [A unit](#a-unit) has the steps.
15. `report.ts` and `collect.ts` read the rows the passes recorded and write the setup reports and the sweep summary to `agent/evals/reports/`. The runner prints the ranking, then runs `scripts/eval-upload.sh`.
16. On the way out, the runner stops every process it started and deletes both Sage builds.

The runner leaves `agent/evals/.runs/<sweep id>/` behind: the resolved sweep file, a log for each process, the rows and transcripts the passes wrote, and `ledger.jsonl`. It is not cleaned up, so you can read it after a failure.

### A unit

A unit is one person under one Dream snapshot. `unit.ts`:

1. Lists the evals each pass would run (`eve eval <ids> --list --json`) and skips the unit when none match. The list is cached for the sweep.
2. Makes a data directory with `prepareDataDir` and restores the Dream cache into it when `dream.ts` finds a snapshot.
3. Starts Sage with `sageEnv`. That environment keeps `HOME` and `PATH`, drops every `SAGE_`, `NATIVE_SDK_`, and credential variable, and sets `SAGE_DATA_DIR`, `SAGE_EMBED_MODEL`, `SAGE_SUMMARY_MODEL`, and `SAGE_OLLAMA_PATH`.
4. On a cache miss, runs `agent/scripts/seed-dataset.ts` and then snapshots the result.
5. Runs the person pass against the stub target.
6. For each Chat prompt, starts a Chat server from that prompt’s root with `startEveServer`. For each setup, it warms the chat model, runs the chat pass against the server, and submits the grade pass to the pool in `passes.ts`.
7. Stops Sage, copies its log and manifest next to the reports, and waits for the Ollama it started to exit.

### The other modules

- `passes.ts`: builds each pass’s environment and `eve eval` arguments, lists evals, and holds the grade pool. Chat and person evals run one at a time and grade evals four at a time. At most two grade processes run at once.
- `proc.ts`: starts child processes in their own process groups, tracks them so an interrupt can stop them, and writes their output to a log with secrets replaced
- `dream.ts`: the Dream cache key for a person, restoring and saving snapshots, and running the seed script with an environment that has no credentials
- `collect.ts`: where each pass leaves its rows, and the code that reads them back
- `cloud.ts`: the price book and the sweep’s spending so far
- `test-fixtures.ts`: made-up people, temporary folders, and a fake `eve` command for the unit tests

## The eval files

Each file turns `case.yaml` references into eve evals. A pass runs the files its prefix names (`person/`, `chat/`, or `grade/`).

- `person/extraction.eval.ts`: facts and events against the memory search endpoints, with judge scores. It skips in memory-off setups.
- `person/summaries.eval.ts`: entry summaries read from SQLite, scored by the judge
- `person/retrieval.eval.ts`: journal search queries, with a top-hit check and the expected entry’s rank
- `chat/facts.eval.ts`: Chat questions for the setup’s chat model. It writes a transcript row for each question and repeat, checks that the turn works, and records the search checks the case asks for.
- `grade/facts.eval.ts`: judge scores for the saved Chat replies
- `evals.config.ts`: the eve config: sequential runs, a ten-minute timeout for each eval, and the result recorder when `SAGE_EVAL_RESULTS` is set. It sets no judge model, because the cloud judge runs through `lib/grader.ts`, where every call counts against the spending cap.

eve imports every `*.eval.ts` file before it filters them, for every pass. So each file must load cheaply and must not throw when its variables are missing. `lib/pass.ts` gives them that: with no `SAGE_EVAL_PERSON` the file exports one skipped placeholder, a person with no items of that kind does the same, and a loading error becomes one eval that throws it when selected.

Eval files never call `send` themselves. They use `sendTurn` in `lib/turn.ts`, which passes the `x-sage-*` headers on every send, because eve drops request headers between turns of one session. A test in `lib/turn.test.ts` fails when an eval file calls `.send(`.

## The helpers

`lib/` holds the code the eval files and scripts share:

- `schema.ts`: the contracts. The sweep file, the setup and its ids, `case.yaml`, transcript rows, the judge’s output shapes, the report files, the ranking, and the names of the pass variables.
- `dataset.ts`: loads people from `data/people/`, parses frontmatter and `case.yaml`, validates a person, and reads the journal-id manifest
- `cache.ts`: computes a person’s Dream cache key, reads Dream prompt folders, and snapshots and restores the database and manifest
- `setup.ts`: turns the pass variables into the setup under test and the `x-sage-model`, `x-sage-think`, and `x-sage-context-length` headers
- `turn.ts`: sends a turn with those headers, times it from the event stream, and decides whether the turn works
- `chat-turn.ts`: sends one Chat question and records its checks and transcript row
- `grader.ts`: the cloud judge. One structured call through AI Gateway, with the spending cap, the rubric hash, and “not graded” results.
- `judge-context.ts`: a person’s fact sheet and full journal as plain text. It depends only on the person and the pinned date, so the gateway can cache it.
- `ledger.ts`: the spending ledger. A call reserves its estimate under a file lock, and settles with its real cost.
- `prices.ts`: reads prices from AI Gateway’s public catalog, caches them for an hour, and works out the cost of a call
- `record.ts`: how eval files write results, as [the results convention](#the-results-convention) explains
- `recorder.ts`: the eve reporter that appends each finished eval to `SAGE_EVAL_RESULTS`
- `transcripts.ts`: appends and loads Chat replies from `SAGE_EVAL_TRANSCRIPTS`
- `pass.ts`: the shared start-up for eval files, described above
- `skip.ts`: a placeholder eval that skips itself
- `rank.ts`: compares how current and stale fact wordings rank
- `sage.ts`: typed calls to the local agent server: journal search, fact and event search, and the profile
- `store.ts`: reads entry summaries from the throwaway SQLite file
- `bridge.ts`: parses bridge responses from the automation folder and chunks UTF-8 text for `journal.save`
- `models.ts`: resolves model names from the environment, for a bare `eve eval` and for the cache-key script
- `upload.ts`: lists report files and names their Vercel Blob pathnames

The scripts in `agent/scripts/` that the runner uses are `seed-dataset.ts` (seed one person and wait for Dream), `automation.ts` (the bridge calls it makes), and `upload-eval-reports.ts` (the upload prompt). `eval-cache.ts` prints a person’s Dream cache key, or snapshots a finished run by hand: `node --experimental-strip-types agent/scripts/eval-cache.ts key --person sam-example --memory on`. It asks the Ollama on `127.0.0.1:11436` for model digests. Without one it warns and hashes the model names only, so the key will not match a run’s. The other shell scripts are listed in [scripts/README.md](../../scripts/README.md).

The Next.js app in `eval-viewer/` reads the uploaded or local report files.

## The pass variables

The runner sets these for each `eve eval` process (`buildPassEnv` in `passes.ts`). `readPassEnv` in `lib/schema.ts` reads them without throwing.

| Variable | What it holds |
| --- | --- |
| `SAGE_EVAL_SWEEP_FILE` | The resolved sweep as JSON. Passes read their settings from it. |
| `SAGE_EVAL_SETUP_ID` | The setup this pass tests, one of the sweep’s setups |
| `SAGE_EVAL_SWEEP_ID` | The sweep id. The judge tags its gateway calls with it. |
| `SAGE_EVAL_PERSON` | The person this pass is about |
| `SAGE_EVAL_RUN_DIR` | The run folder, which holds the spending ledger |
| `SAGE_EVAL_RESULTS` | The file where the recorder appends each finished eval |
| `SAGE_EVAL_TRANSCRIPTS` | The Chat transcripts: the chat pass appends, the grade pass reads |
| `SAGE_EVAL_MANIFEST` | The journal ids the seed step wrote |
| `SAGE_EVAL_DATA` | The folder that holds `people/` |
| `SAGE_DATA_DIR` | The throwaway data directory, where the person pass reads `app.db` |
| `SAGE_DISCOVERY_FILE` | The throwaway `agent-server.json`, for the socket and token |
| `SAGE_TODAY` | `2026-11-15` |
| `SAGE_CHAT_MODEL`, `SAGE_EMBED_MODEL`, `SAGE_SUMMARY_MODEL` | The setup’s models |
| `SAGE_REPO_ROOT` | The repo root |
| `EVE_EVAL_AUTH_TOKEN` | Sage’s token. The chat pass only. |
| `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN` | The judge’s credential, when set. Evals only. |

With no `SAGE_EVAL_SWEEP_FILE`, a bare `eve eval` builds its setup from the environment: memory on, the shipped prompt, `OLLAMA_CONTEXT_WINDOW` for the context length, `SAGE_CHAT_MODEL` (then `OLLAMA_MODEL`) for the chat model, and the defaults for the rest.

## The results convention

Eval files record results with `lib/record.ts` and nothing else, so the runner can read them.

- An eval’s `metadata` is `{ itemId, kind, person, repeat, setupId }`. The item id reads `<person>/<kind>/<number>`.
- Each check is one `t.score` labeled `<tier>:<checkId>`. The tier is `hard`, `counted`, `rubric`, `slip`, or `search`, or `soft` for a score with no check id of its own. Check ids and tiers are in `CHECK_TIERS` in `schema.ts`.
- The metadata of a check holds `checkId`, `tier`, and the item’s fields. It can hold `turnIndex`, `reason`, `evidence`, and `notGraded`. A judged check also holds `judgeModel`, `rubric` (the rubric hash), `judgeCallId`, and `judgeCostUsd`.
- A hard check gates, so one miss fails the eve eval. A counted check is soft with a bar of 1, so a miss never fails it. Everything else is soft with no bar.
- A judge error is recorded with `notGraded: true`. It never gates, because a judge error is not a failure. An eval that skips with a reason that starts “not graded” counts the same way, and any other skip means “does not apply”.
- `report.ts` turns the rows into items. A soft score whose id is not in `CHECK_TIERS` goes into the item’s `note` as `<id> <score>`.

To add a check, add its id to the right list in `schema.ts`, record it with `recordCheck`, and add a test.

## Unit tests

Every test runs without Ollama or a cloud key, as part of `make test`:

- `npm --prefix agent run test:evals` runs `lib/*.test.ts`.
- `npm --prefix agent run test:scripts` runs `agent/scripts/*.test.ts` and `agent/scripts/eval/*.test.ts`. `scripts/dev-auth-hook.test.ts` covers the dev-terminal auth hook: which URLs get Sage’s token, which keep the header eve built, and what happens before `agent-server.json` exists.
- `node --test --experimental-strip-types security-tests/*.test.ts` runs the security tests. [Testing the lock and encryption](../../docs/security/testing.md#the-security-tests) lists the ones that cover the runner.

`unit.test.ts` runs a whole unit against stand-ins for Sage and the seed step. Use `test-fixtures.ts` for made-up people and a fake `eve`.
