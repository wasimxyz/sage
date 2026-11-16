# Eval suite internals

This page is for people changing the eval runner or the eval files. To run the suite, see [docs/agent/evals.md](../../docs/agent/evals.md). To read results, see [docs/agent/evals-reports.md](../../docs/agent/evals-reports.md). To write people, see [data/README.md](data/README.md).

## The runner

`make eval` runs `node --experimental-strip-types agent/scripts/eval/run.ts --sweep <name> <ARGS>`. `npm --prefix agent run sweep` runs the same entry point. `run.ts` checks first that no agent is running it (`agent-guard.ts`): with `CLAUDECODE` set, it prints “make eval is run by you, not by an agent.” and exits with code 2, `--dry-run` included, and no option turns that off. Then it parses the command line before anything else loads, so a bad option, including `--url`, stops there with exit code 2. The stages live in `runner.ts`.

One run does this:

1. `cli.ts` reads `--sweep`, `--resume`, `--compare`, `--dry-run`, `--yes`, and the eve filters. `--resume` and `--compare` take a sweep id, which names files, so a path is refused, and they cannot be used together. It refuses `--url` first, then the options the runner owns: `--json`, `--junit`, `--list`, and `--max-concurrency`.
2. `env.ts` loads `agent/.env`, then `agent/.env.local`, without replacing values the shell already set.
3. `sweep.ts` reads `agent/evals/sweeps/<name>.yaml`, applies `SAGE_SUMMARY_MODELS`, `SAGE_EMBED_MODELS`, and `SAGE_CHAT_MODELS`, and parses the file with `parseSweepFile`. It refuses thinking levels the agent cannot honor, expands the setups, and makes the sweep id.
4. `people.ts` loads the people through `lib/dataset.ts`, checks them with `validatePerson` as of 2026-11-15, and keeps the ones the sweep’s `tags` cover, except the people whose tags hold one of its `excludeTags` (`long-history` is tagged `long`). It also keeps `new-user` when the sweep sends openers or conversations and a covered person has an `alsoEmpty` one the tags pick, because the empty journal is `new-user`’s Sage (`selectPeople`). `dataProblems` stops the plan when an opener or a conversation is marked `alsoEmpty` and there is no `new-user`, or when `new-user` has entries.
5. `plan.ts` maps `tests` to eval ids, groups the setups by Dream snapshot and by Chat prompt, and counts Sage starts, Chat server starts, and model loads. `facts` and `openers` both map their grade pass to `grade/replies`, and `resolveTests` lists an id once, so a sweep that names both runs one grade pass and each reply is graded once. The openers `new-user` sends on the empty journal are counted in its total (`emptyJournalOpenerCount`). `calibration` and `head-to-head` run alone: `standaloneTest` finds them, and the runner takes the [no-Sage path](#sweeps-with-no-sage) instead of this list. When no test sends a Chat message (`needsChat`), the plan has no Chat servers, Chat passes, or model loads, and the runner leaves the chat model out of the model checks. `dream.ts` (`dreamPromptProblems`) stops the plan, with exit code 2, when a folder named in `dreamPrompts` is missing, empty, misnamed, or holds a prompt file Sage will not use (an empty one, one that is not a regular file, or one of 64 KiB or more).
6. `overlay.ts` builds `agent/.eval-roots/<prompt>/` for each Chat prompt, and the stub `_target`. `eve info --json` must report each root as ready. With no Chat, it builds only the stub.
7. `eve.ts` starts `eve dev` on the stub target and waits for `GET /eve/v1/health`.
8. `ollama.ts` gets the pinned Ollama, starts a temporary server on `127.0.0.1:11436`, and asks `/api/show` about every model. It lists missing models, rejects a chat model with no tools, and notes the models that cannot think.
9. `estimate.ts` prints the hours and dollars, with prices from `cloud.ts`. `--dry-run` ends here.
10. The runner stops if no gateway key is set, and asks to continue unless `--yes` is set.
11. `judge-check.ts` runs the judge check: `eve eval judge-check` against the stub target, with the gateway key and no person, setup, or Sage. It reads the `hard:judge-check` rows and stops the sweep with exit code 1 on a miss, a false alarm, or an item the judge could not grade. [The judge check](#the-judge-check) has the details. Nothing has been pulled, built, or seeded yet, and a test in `runner.test.ts` keeps the check in that place.
12. `ollama.ts` pulls the missing models, and the runner stops the temporary server.
13. `sage.ts` builds Sage once for each memory value: `native build -Dinstall-prefix=zig-out/eval-mem<0|1> -Dautomation=true -Dmemory=<false|true>`.
14. `unit.ts` runs one unit for each memory value, Dream snapshot, and person. [A unit](#a-unit) has the steps.
15. `report.ts` and `collect.ts` read the rows the passes recorded and write the setup reports and the sweep summary to `agent/evals/reports/`. The summary holds the judge check result. The runner prints the ranking, then runs `scripts/eval-upload.sh`.
16. On the way out, the runner stops every process it started and deletes both Sage builds.

The runner leaves `agent/evals/.runs/<sweep id>/` behind: the resolved sweep file, a log for each process, the rows and transcripts the passes wrote, `ledger.jsonl`, and the files `--resume` reads (`plan.json` and `done/`). It is not cleaned up, so you can read it after a failure. [Resuming](#resuming) explains the rest.

### Resuming

`resume.ts` holds everything `--resume <sweep id>` needs, and `unit.ts` and `runner.ts` call it.

- `plan.json` is written when a run starts, unless it is a dry run. It records the sweep file's name, `sweepHash` (the hash of `resolvedSweepJson`, which covers the file, the model lists the environment replaced, and every default), the sorted setup ids and people, how many sessions have run, and how long they took (`priorMs`).
- `loadRun` reads the plan of the run to resume, takes the sweep name from it (`sweepNameOf`: `make eval` always passes `--sweep`, so `default` means none), and loads the sweep. `openRun` calls `planFileFor`, which is `checkResume` for a resume and `newPlanFile` for a new run. `checkResume` throws a `ResumeError`, which becomes a `Stop` with exit code 2, when the hash, the setups, or the people differ. A resume keeps the sweep id and the run folder, so the ledger keeps counting.
- A `Step` is `judge-check`, `person` (per snapshot and person), `chat` (per setup and person), or `grade` (per setup and person). `markDone` writes `done/<kind>/.../<name>.json`. Nothing writes a marker for a pass that crashed (`PassOutcome.status`) or for one that ran while `abort.aborted` was set, so a resume does it again.
- `resetStep` deletes what a step left, and runs before the step starts, in a new run too, where it deletes nothing. A chat step takes its transcripts, its results, its log, its memory readings (`dropMemoryReadings`), and the grade files and marker of the same setup and person. That is what keeps a pass killed halfway from leaving rows that the next pass writes again. Transcripts and results are appended to, and the grade eval would otherwise read the stale row too.
- `pendingWork` says which of person, chat, and grade have work left in a unit. In `runUnit`, nothing left skips the unit, and only grading left runs `runGradeOnly` with no Sage, reading the manifest copy that `runWithSage` saved after seeding (`savedManifestPath`). In `runPrompt`, setups whose replies are saved only get graded, and the Chat server starts only for the setups that still need generating.
- `judgeCheckOnce` in `runner.ts` skips the judge check when its marker holds a passing summary, and otherwise resets it, runs it, and writes the marker only when it passed.
- `trackElapsed` keeps the hours across sessions: `plan.json` gets `priorMs` when the run ends, however it ends, and the report's actual hours start from it.

### Sweeps with no Sage

`calibration` and `head-to-head` have no setups of their own and need no Sage, Ollama, or build. `runStandaloneSweep` in `runner.ts` runs them: it reads their inputs first (`calibrationInputs`, `headToHeadPreflight`), so a missing sample or an unfinished sweep stops the run before anything starts. Then it builds and starts the stub target, prints an estimate (`standalone.ts`), asks, and runs one grade pass with `runStandalone`. That pass has the judge check's environment: no person, no setup, and the gateway key. The runner reads the rows it recorded. `calibration-run.ts` turns them into `<run id>.calibration.json`. `head-to-head-run.ts` turns them into the `headToHead` field, and `mergeHeadToHead` adds it to the compared sweep's `.sweep.json`. Head-to-head runs the judge check first. Calibration does not.

### A unit

A unit is one person under one Dream snapshot. `unit.ts`:

1. Lists the evals each pass would run (`eve eval <ids> --list --json`) and skips the unit when none match. The list is cached for the sweep.
2. Makes a data directory with `prepareDataDir` and restores the Dream cache into it when `dream.ts` finds a snapshot.
3. Starts Sage with `sageEnv`. That environment keeps `HOME` and `PATH`, drops every `SAGE_`, `NATIVE_SDK_`, and credential variable, and sets `SAGE_DATA_DIR`, `SAGE_EMBED_MODEL`, `SAGE_SUMMARY_MODEL`, and `SAGE_OLLAMA_PATH`. For a Dream prompt variant, it also sets `SAGE_EVAL_DREAM_PROMPTS`. No other process gets that variable: `withoutSageOnly` in `env.ts` removes it from the environments of the passes, the Chat server, and the seed script.
4. On a cache miss, runs `agent/scripts/seed-dataset.ts` and then snapshots the result. A person with past chats (`seedsInStages`) is seeded in two stages. The first (`SAGE_EVAL_SEED_STAGE=content`) saves the entries and chats and indexes the chats. Then `unit.ts` stops Sage, calls `rewriteChatTimes` from `chat-times.ts` on `app.db`, starts a new Sage in the same folder, and runs the second stage (`dream`), which runs Dream. `startSage` first clears the discovery file and the automation folder the old Sage left, so the new Sage is waited for on its own files and finds no old commands.
5. Runs the person pass against the stub target. It gets `SAGE_EVAL_DREAM_KEY`, the snapshot’s key, for Dream accuracy’s grade cache.
6. For each Chat prompt, starts a Chat server from that prompt’s root with `startEveServer`. For each setup, it warms the chat model, runs the chat pass against the server, and submits the grade pass to the pool in `passes.ts`. The warm-up and the chat pass run inside `measureMemory`, which samples swap and the loaded models, and saves one reading for the pass. A sweep with no Chat test skips this step.
7. Stops Sage, copies its log and manifest next to the reports, and waits for the Ollama it started to exit.

### The other modules

- `passes.ts`: builds each pass’s environment and `eve eval` arguments, lists evals, and holds the grade pool. Chat and person evals run one at a time and grade evals four at a time. At most two grade processes run at once. `buildJudgeCheckEnv` builds the judge check’s smaller environment.
- `resume.ts`: the plan file, the done markers, `resetStep`, and `checkResume`, as [Resuming](#resuming) explains
- `standalone.ts`: runs the one grade pass of a sweep with no Sage, and estimates its calls
- `calibration-sample.ts`: picks the replies to grade. `seededRandom` and `shuffled` give the same order for the same seed, `pickStratified` takes one reply from each kind of message in turn and from each setup in turn, and `chooseSample` puts the failures first and keeps a quarter for passes. `npm --prefix agent run calibration-sample -- <sweep id>` runs it.
- `calibration-run.ts`: the inputs of the `calibration` sweep, the reading of its rows, and the report file
- `head-to-head-run.ts`: the preflight of the `head-to-head` sweep (which setups, which items, how many calls), the reading of its rows, and the merge into the compared sweep's summary
- `judge-check.ts`: runs the judge check, reads its rows, and decides whether the sweep may go on. `isJudgeCheckRow` picks out its rows, which `report.ts` leaves out of every setup report.
- `proc.ts`: starts child processes in their own process groups, tracks them so an interrupt can stop them, and writes their output to a log with secrets replaced
- `dream.ts`: the Dream cache key for a person, restoring and saving snapshots, checking the Dream prompt folders a sweep names, and running the seed script with an environment that has no credentials. `seedsInStages` and `seededChatDays` serve the two-stage seed of a person with past chats.
- `chat-times.ts`: `rewriteChatTimes` moves seeded past chats to their own days in a stopped Sage’s database. It refuses any path that is not `app.db` in a `sage-eval-*` folder.
- `memory-pressure.ts`: samples `sysctl vm.swapusage` and Ollama’s `/api/ps` (`MemoryMonitor`, `measureMemory`), saves one reading for each pass under `.runs/<sweep id>/memory/`, and combines them into the swap reading the report uses. The two probes are passed in, so tests answer for them.
- `collect.ts`: where each pass leaves its rows, and the code that reads them back
- `cloud.ts`: the price book and the sweep’s spending so far
- `test-fixtures.ts`: made-up people, temporary folders, and a fake `eve` command for the unit tests

## The eval files

Each file turns `case.yaml` references into eve evals. A pass runs the files its prefix names (`person/`, `chat/`, or `grade/`).

- `person/extraction.eval.ts`: facts and events against the memory search endpoints, with judge scores. It skips in memory-off setups.
- `person/summaries.eval.ts`: entry summaries read from SQLite, scored by the judge
- `person/retrieval.eval.ts`: journal search queries, with a top-hit check and the expected entry’s rank
- `person/dream-accuracy.eval.ts`: one eval for each entry of the person and each chat in the database. The judge grades the source against everything Dream wrote from it. [Dream accuracy](../../docs/agent/evals.md#dream-accuracy) explains the checks.
- `judge-check/dream.eval.ts`: one eval for each labeled item in `judge-check/dream/*.yaml`. It records `hard:judge-check`, a pass only when the judge’s verdicts match the labels. It takes no person and no setup, and its rows carry the person `judge-check`.
- `judge-check/replies.eval.ts`: the same for the labeled Chat replies in `judge-check/replies/*.yaml`. Each item names a person and one of their openers. The eval reads only the YAML when it loads, and looks up the person and the opener when the item runs.
- `judge-check/conversations.eval.ts`: the same for the labeled conversations in `judge-check/conversations/*.yaml`. Each item names a person, carries its own labels and turns, and lists the checks the judge must fail, each on a turn.
- `chat/facts.eval.ts`: Chat questions for the setup’s chat model. It writes a transcript row for each question and repeat, checks that the turn works, and records the search checks the case asks for.
- `chat/openers.eval.ts`: one eval for each opener and repeat of the pass’s person, picked by the sweep’s `tags`. For `new-user` it adds the `alsoEmpty` openers of everyone else, as `journal: empty`. It sends with `sendTurn`, checks that the turn works, and writes a transcript row of kind `opener`.
- `chat/conversations.eval.ts`: one eval for each conversation and repeat of the pass’s person, picked by the sweep’s `tags`. For `new-user` it adds the `alsoEmpty` conversations of everyone else, as `journal: empty`, and it leaves out people the sweep excludes. A simulated user plays the person (`lib/simulated-user.ts`), and each Sage turn goes through `sendTurn` and records `counted:turn-works` on its own turn. It writes one transcript row of kind `conversation`, with the turns, how it ended, the simulated user’s flags and rating, and a note. A conversation gets 30 minutes, and 2 hours when `maxTurns` is over 12.
- `grade/conversations.eval.ts`: one eval for each saved conversation. Each Sage reply is graded as a reply, with the turns before it, and the whole conversation gets one more judge call. [Grading conversations](../../docs/agent/evals.md#grading-conversations) has the details.
- `grade/replies.eval.ts`: one eval for each saved reply, openers and fact questions, with one judge call each. It records the hard checks, the counted checks, the judge’s slips, and the rubric that apply. Before the judge is asked, it records the search checks and the pattern slips, which need no judge. It replaced `grade/facts.eval.ts`.
- `calibration/agreement.eval.ts`: one eval for each sampled reply that you graded in `calibration/grades.jsonl`. It asks the judge about the reply and records `soft:calibration` with both sets of verdicts in its metadata. The runner turns those into the agreement report. [The calibration README](calibration/README.md) has the formats.
- `grade/head-to-head.eval.ts`: one eval for each item of each pair of the top setups of the sweep that `compare` names. It judges the item in both orders and records `soft:head-to-head` with the result. Any other pass gets a skipped placeholder.
- `evals.config.ts`: the eve config: sequential runs, a ten-minute timeout for each eval, and the result recorder when `SAGE_EVAL_RESULTS` is set. It sets no judge model, because the cloud judge runs through `lib/grader.ts`, where every call counts against the spending cap.

The folders beside the eval files hold their inputs. `judge-check/` holds the labeled items and a README that explains the format. `dream-prompts/` holds the Dream prompt variants that `dreamPrompts` names, one folder each, and its README lists the four files a variant may hold. `sweeps/` holds the sweep files: `default`, `smoke`, `dream`, `screen`, `quick`, `deep`, `deep-memory-on`, `calibration`, and `head-to-head`. `calibration/` holds the calibration samples and your grades. `prompts/` holds the Chat prompts a sweep can compare.

eve imports every `*.eval.ts` file before it filters them, for every pass. So each file must load cheaply and must not throw when its variables are missing. `lib/pass.ts` gives them that: with no `SAGE_EVAL_PERSON` the file exports one skipped placeholder, a person with no items of that kind does the same, and a loading error becomes one eval that throws it when selected.

Eval files never call `send` themselves. They use `sendTurn` in `lib/turn.ts`, which passes the `x-sage-*` headers on every send, because eve drops request headers between turns of one session. A test in `lib/turn.test.ts` fails when an eval file calls `.send(`.

## The helpers

`lib/` holds the code the eval files and scripts share:

- `schema.ts`: the contracts. The sweep file, the setup and its ids, `case.yaml`, transcript rows, the judge’s output shapes, the report files, the ranking, and the names of the pass variables.
- `dataset.ts`: loads people from `data/people/` with their entries and past chats (`chats/*.md`, as `LoadedPerson.chats`), parses frontmatter and `case.yaml`, validates a person, resolves a `needs` ref to an entry or a `chat:<stem>` chat (`resolveNeed`), and reads the journal-id and chat-id manifest
- `cache.ts`: computes a person’s Dream cache key, reads Dream prompt folders, and snapshots and restores the database and manifest
- `setup.ts`: turns the pass variables into the setup under test and the `x-sage-model`, `x-sage-think`, and `x-sage-context-length` headers
- `turn.ts`: sends a turn with those headers, times it from the event stream, and decides whether the turn works
- `chat-turn.ts`: sends one Chat message, a fact question (`runChatQuestion`) or an opener (`runOpener`), and records its checks and transcript row
- `openers.ts`: which openers a pass sends. It applies the sweep’s tags, adds the `alsoEmpty` openers to `new-user`, gives a run on the empty journal its `.empty` item key, and builds the evals.
- `checks.ts`: which hard checks, counted checks, slips, and rubric items apply to a reply, and which rubric items are N/A. Search quality is N/A when the turn made no search call. The judge answers what this file says and nothing else.
- `tool-names.ts`: the names of Chat’s tools, and which calls count as searches. The memory tool counts only with memory on.
- `search-checks.ts`: `needless-search`, `missed-search`, `found-needed`, and `no-runaway-search`, from one turn’s tool calls. The top of the file defines found and read. `resolveSearchNeeds` turns an item’s `needs` into ids with the seed step’s manifest.
- `slips.ts`: `shows-internals`, `many-questions`, `not-chat-length`, and `formatting`, from patterns in the reply. The judge answers the other two slips.
- `rubric.ts`: the words the judge is given for a reply (the checks, the rubric, the answer format), the layout of its call, and `replyGradeCall`, which builds it
- `reply-grade.ts`: turns a transcript row into what the judge sees, asks the judge, records its answer, and builds the evals of `grade/replies`
- `simulated-user.ts`: the cloud model that plays the person in a conversation. It builds the persona card and the prompts, limits the gateway to the sweep’s providers that are within the price limit, and makes its calls through a grader of its own, so its spending goes through the same ledger and cap. It never throws: a failure is a result. A failed setup is tried once more and is never kept, so one network blip ends one conversation and not the rest. The runner calls `resolveSimulatedUser` before any local work when the sweep runs conversations.
- `conversation-run.ts`: plays one conversation. It writes the opening, the crisis, and the `script` turns word for word, asks the simulated user for the rest, sends every turn with `sendTurn`, ends on `done`, `maxTurns`, or an error, and returns the transcript row.
- `conversations.ts`: which conversations a pass runs, how the `.empty` runs and the excluded people are handled, and the evals of `chat/conversations`
- `conversation-checks.ts`: which checks apply to which turn of a conversation, and how the judge’s marks become counted checks. The first return to a worry is forgiven, and `crisis-handled` applies from the crisis turn on and to no turn before it. Each turn has its own `expect` and `search` (a scripted turn can carry its own), and `conversationRulesMaterial` shows those rules to the rubric hash. Code decides all of it.
- `conversation-rubric.ts`: the words the judge is given for a whole conversation, and the layout of its call
- `conversation-grade.ts`: turns a transcript row into the calls of the judge (each reply, and the whole conversation), records the answers, and builds the evals of `grade/conversations`
- `grader.ts`: the cloud judge. One structured call through AI Gateway, with the spending cap, the rubric hash, and “not graded” results. The rubric hash (`rubricMaterial`) covers every rubric text, every answer schema, the layout of each prompt, the journal and Dream-source layouts, the rules for which checks apply to a reply, the temperature, and the output cap. `dreamSourceCall` and `replyCall` build the Dream-source and reply calls, so the call the eval sends is the one the hash read.
- `judge-context.ts`: a person’s fact sheet, full journal, and past chats as plain text. It depends only on the person and the pinned date, so the gateway can cache it.
- `dream-judge-input.ts`: what the Dream-source judge sees: the fact sheet without the journal, and a source next to everything Dream wrote from it. It sits apart from `dream-accuracy.ts` so the grader can hash its layout.
- `dream-accuracy.ts`: reads what Dream wrote from the throwaway SQLite file (read-only), groups it by source, grades each source, and records the two checks and the `dream-source` score. Everything it touches is passed in, so its tests use a temp database and a mock judge.
- `dream-grade-cache.ts`: the Dream accuracy grades, kept in the snapshot’s folder and keyed by judge model, the Dream-source rubric hash (`dreamSourceRubricHash`, which leaves out the reply rubric), and the text the judge saw. It never makes the folder.
- `sweep-source.ts`: reads a finished sweep back: its summary, its setup reports, and the transcripts in its run folder when they are still there. A transcript wins over the report's own turns (`sourceRow`), and a sweep from another Mac works from its reports alone.
- `calibration.ts`: the sample and grade file shapes, the agreement math (`quadraticWeightedKappa`, `rubricAgreement`, `checkAgreement`), the report, and `calibrationEvals`. It builds the labels of a sampled reply from the person's `case.yaml` the way a real reply gets them (`labelsOfSample`), including the turn's own `expect` in a conversation.
- `head-to-head.ts`: picks the top setups and the items they share, builds the judge's input for each order (`inputFor`), settles an item from its two orders (`settleOrders`), tallies pairs and standings, and builds `headToHeadEvals`
- `head-to-head-rubric.ts`: the words the judge is given to compare two answers, and the layout of its call. `grader.ts` builds the call through `headToHeadCall`, so the rubric hash covers it.
- `sweep-fixtures.ts`: made-up finished sweeps and a fake judge for the tests of the above. It is not a test file.
- `judge-check.ts`: parses the labeled items of the Dream and reply halves, grades them with the real Dream-source and reply calls, and compares the verdicts with the labels. It names each miss and records `hard:judge-check`.
- `judge-check-conversations.ts`: the same for the conversation half, with the real reply and conversation calls. It compares each (check, turn) pair with the labels.
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
- `bridge.ts`: parses bridge responses from the automation folder, chunks UTF-8 text for `journal.save`, and names the seed stages and the variable that picks one
- `models.ts`: resolves model names from the environment, for a bare `eve eval` and for the cache-key script
- `upload.ts`: lists report files and names their Vercel Blob pathnames

The scripts in `agent/scripts/` that the runner uses are `seed-dataset.ts` (seed one person and wait for Dream, in one go or in the two stages of a person with past chats), `seed-chats.ts` (saves a person’s past chats with `chat.save` and indexes them with `embeddings.generate`, through a bridge function the caller passes in), `automation.ts` (the bridge calls it makes), and `upload-eval-reports.ts` (the upload prompt). `eval-cache.ts` prints a person’s Dream cache key, or snapshots a finished run by hand: `node --experimental-strip-types agent/scripts/eval-cache.ts key --person sam-example --memory on`. It asks the Ollama on `127.0.0.1:11436` for model digests. Without one it warns and hashes the model names only, so the key will not match a run’s. The other shell scripts are listed in [scripts/README.md](../../scripts/README.md).

The Next.js app in `eval-viewer/` reads the uploaded or local report files.

## The judge check

`judge-check.ts` in the runner starts the check. It runs the folder `judge-check`, so it picks up all three halves. `lib/judge-check.ts`, `lib/judge-check-conversations.ts`, and the eval files in `judge-check/` are the check itself. To change what the check proves:

- Add an item to `judge-check/dream/planted.yaml` (the judge must flag it) or `clean.yaml` (the judge must not). The folder’s README has the format. Give a planted item one wrong claim, so its labels are clear.
- Add a reply to `judge-check/replies/planted.yaml` or `clean.yaml`. Name a person and one of their openers, write the reply, and list the checks the judge must fail in `expect.fails`. A test resolves every shipped item against the real people, and fails when an opener is gone or a label names a check that does not apply to it. A clean item can also bound a rubric score, such as `right-help: { min: 4 }`.
- Add a conversation to `judge-check/conversations/planted.yaml` or `clean.yaml`. It carries its own labels and turns, and `expect.fails` lists each check with the turn it fails on. A conversation item makes one call for the whole conversation and one for each turn in `gradeReplies`.
- Changing a rubric or a prompt layout changes the rubric hash. Run a sweep afterward, and the check tells you whether the judge still catches every planted failure.

The check never uses the grade cache, because the judge is what it tests. Its cost counts against the sweep’s spending cap.

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
| `SAGE_EVAL_MANIFEST` | The journal and chat ids the seed step wrote. The grade pass reads it to turn `needs` into ids. |
| `SAGE_EVAL_SEED_STAGE` | `all`, `content`, or `dream`. The seed script only, not an `eve eval` pass. |
| `SAGE_EVAL_DREAM_KEY` | The key of the person’s Dream snapshot. The person pass only. Dream accuracy keys its grade cache with it. Not part of `EVAL_ENV`. |
| `SAGE_EVAL_DATA` | The folder that holds `people/` |
| `SAGE_DATA_DIR` | The throwaway data directory, where the person pass reads `app.db` |
| `SAGE_DISCOVERY_FILE` | The throwaway `agent-server.json`, for the socket and token |
| `SAGE_TODAY` | `2026-11-15` |
| `SAGE_CHAT_MODEL`, `SAGE_EMBED_MODEL`, `SAGE_SUMMARY_MODEL` | The setup’s models |
| `SAGE_REPO_ROOT` | The repo root |
| `EVE_EVAL_AUTH_TOKEN` | Sage’s token. The chat pass only. |
| `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN` | The judge’s credential, when set. Evals only. |

`SAGE_EVAL_DREAM_PROMPTS` is in `EVAL_ENV`, but the runner sets it for Sage only. No `eve eval` process gets it.

The judge check gets a smaller set: the sweep file, the sweep id, the run folder, its own results file, `SAGE_TODAY`, and the gateway credential (`buildJudgeCheckEnv`). It gets no person, setup, manifest, transcripts, discovery file, or data directory, even if the shell that started the runner set one.

With no `SAGE_EVAL_SWEEP_FILE`, a bare `eve eval` builds its setup from the environment: memory on, the shipped prompt, `OLLAMA_CONTEXT_WINDOW` for the context length, `SAGE_CHAT_MODEL` (then `OLLAMA_MODEL`) for the chat model, and the defaults for the rest.

## The results convention

Eval files record results with `lib/record.ts` and nothing else, so the runner can read them.

- An eval’s `metadata` is `{ itemId, kind, person, repeat, setupId }`. The item id reads `<person>/<kind>/<number>`.
- Each check is one `t.score` labeled `<tier>:<checkId>`. The tier is `hard`, `counted`, `rubric`, `slip`, or `search`, or `soft` for a score with no check id of its own. Check ids and tiers are in `CHECK_TIERS` in `schema.ts`.
- The metadata of a check holds `checkId`, `tier`, and the item’s fields. It can hold `turnIndex`, `reason`, `evidence`, and `notGraded`. A judged check also holds `judgeModel`, `rubric` (the rubric hash), `judgeCallId`, and `judgeCostUsd`.
- A hard check gates, so one miss fails the eve eval. A counted check is soft with a bar of 1, so a miss never fails it. Everything else is soft with no bar.
- A judge error is recorded with `notGraded: true`. It never gates, because a judge error is not a failure. An eval that skips with a reason that starts “not graded” counts the same way, and any other skip means “does not apply”.
- `report.ts` turns the rows into items. A soft score whose id is not in `CHECK_TIERS` goes into the item’s `note` as `<id> <score>`, except `dream-source`, which adds no note. Its `dream` metadata (the source, what Dream wrote, and each claim) goes into the item’s `dream` for the viewer.
- Dream accuracy records one item for each source, with kind `dream-source` and an id such as `sam/dream/2026-09-03-lost-mia` or `sam/dream/chat-2`. Its checks are `hard:no-severe-unsupported` (once for the source), `counted:dream-supported` (once for each item Dream wrote from it, with `dreamItemVerdicts` matching each `other` claim to its item), and the soft `dream-source`.
- The grade evals put `expect` in the eval's metadata, and the judged checks of a reply carry the `expect` of their turn, so `report.ts` can say what an item and each turn of a conversation are about. A conversation's own `expect` is on the item, and each turn has the kind it answered: a scripted turn can be `pushback`, and from the crisis turn on a turn is `crisis`.
- The calibration eval records one soft score, `soft:calibration`, for each reply you graded. Its metadata holds `comparison` (`{ checks, rubric }`, each id with `human` and `judge`), `sampleId`, and `calibrationId`. The head-to-head eval records `soft:head-to-head` for each item of each pair, with `a`, `b`, `pair`, and `result` (the item with its two orders) in the metadata. Both carry `notGraded: true` and no result when the judge fails. Their rows go to `.runs/<run id>/calibration/` or `.runs/<run id>/head-to-head/`, and no setup report holds them.
- An opener is an item of kind `opener`, with an id such as `work/opener/checklist-is-back`. Its run on the empty journal has the same id with `.empty` added and `journal: empty` on its transcript row, so the two runs stay apart. A fact question keeps kind `chat` and its `<person>/chat/<n>` id.
- A conversation is an item of kind `conversation`, with an id such as `engaged/conversation/wedding-costs`, and `.empty` added for its run on the empty journal. The chat pass records `counted:turn-works` on each Sage turn with its `turnIndex`. The grade pass records the checks of each reply on that reply’s `turnIndex`, and the checks that need the whole conversation with no turn or on the reply they are about: `counted:stops-feeding-loop` (from the second return on) and `counted:drops-after-no` on the replies, and `rubric:follows-lead`, `rubric:collaboration`, `rubric:keeps-track`, and `rubric:user-rating` on the item. `rubric:follows-lead` carries the judge’s `loopMarks` and `declineMarks` and the final `simulatedUserFlags` in its metadata, and the report reads each mark once. A conversation that is left out of the conversation rubric has those four recorded with `notApplicable: true` and the reason. Every record of a judge call names its `judgeCallId` and `judgeCostUsd`, even an N/A one, so the report counts its cost once.
- The search checks (`search:needless-search`, `search:missed-search`, `search:found-needed`) and the slips (`slip:<id>`) are soft with no bar. `counted:no-runaway-search` is counted. A slip or search check that does not apply is not recorded, or is recorded with `notApplicable: true`. `search:found-needed` carries `needs`, one `{ ref, id, found, read, readRequired }` for each need, in its metadata, and is “not graded” when the manifest has no id for a need.
- The grade pass records every check of a Chat reply with `turnIndex` set to the reply’s turn. That puts the checks, the rubric scores, `journalErrors`, and `helpSeen` on the assistant turn in the report. A rubric item that does not apply has `notApplicable: true`, which the report reads as skipped. A rubric score is the judge’s level from 0 to 1, with the level in the metadata. `helpSeen` rides on the `right-help` record, even when it is N/A.
- The judge check records `hard:judge-check` with kind `dream-source` (Dream items) or `opener` (reply items), the person `judge-check`, and ids such as `judge-check/dream/lost-mia-death` or `judge-check/reply/missed-crisis`. The metadata holds `misses`, a list of `{ check, kind, detail, itemId }`. The rows go to `agent/evals/.runs/<sweep id>/judge-check/`, not into a setup report. `JUDGE_CHECK_PERSON` in `schema.ts` names the person.

To add a check, add its id to the right list in `schema.ts`, record it with `recordCheck`, and add a test.

## Unit tests

Every test runs without Ollama or a cloud key, as part of `make test`:

- `npm --prefix agent run test:evals` runs `lib/*.test.ts`.
- `npm --prefix agent run test:scripts` runs `agent/scripts/*.test.ts` and `agent/scripts/eval/*.test.ts`. `scripts/dev-auth-hook.test.ts` covers the dev-terminal auth hook: which URLs get Sage’s token, which keep the header eve built, and what happens before `agent-server.json` exists.
- `node --test --experimental-strip-types security-tests/*.test.ts` runs the security tests. [Testing the lock and encryption](../../docs/security/testing.md#the-security-tests) lists the ones that cover the runner.

`unit.test.ts` runs a whole unit against stand-ins for Sage and the seed step. Use `test-fixtures.ts` for made-up people and a fake `eve`.
