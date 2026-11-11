# Eval reports

This page explains what `make eval` writes, how to read it, and how to fix the failures you are most likely to hit. To run the suite first, see [Eval suite](evals.md).

## Where reports go

Each sweep has an id: the UTC start time and the sweep’s name, such as `2026-11-10T031500Z-smoke`. A run writes these files to `agent/evals/reports/`:

- `<sweep id>__<setup id>.report.json`: one report for each setup. The setup id is a 10-character hash of the setup’s eight values, so the same setup gets the same id in every sweep.
- `<sweep id>.sweep.json`: the sweep file with its defaults filled in, the estimated and real hours and cost, the result of [the judge check](#the-judge-check-result), and the ranking of the setups
- `<sweep id>__<snapshot id>__<person>.sage.log`: what the throwaway Sage printed for one person. The snapshot id is a 10-character hash of the summary model, embedding model, Dream prompt, and memory value, so setups that share a Dream snapshot share it.
- `<sweep id>__<snapshot id>__<person>.manifest.json`: the journal ids the seed step wrote, so you can trace an item back to database rows

The runner also keeps its working files in `agent/evals/.runs/<sweep id>/`: the sweep file the passes read, a log for every process, the rows each pass recorded (`*.results.jsonl`), the rows of the judge check (in `judge-check/`), the saved Chat transcripts, and the spending ledger. Git ignores the folder. Delete it when you no longer need the logs.

Older runs wrote a JUnit file named `<run id>.xml` instead. The report viewer still opens those.

## What a setup report holds

- The setup, the git commit (with `+dirty` when you have uncommitted changes), the judge settings, and short hashes of the Chat prompt, the Dream prompt, and the judge’s rubric. The Dream hash is `null` for the built-in prompts.
- A summary: how many items were graded, not graded, and skipped, the hard failures, the counted failures for each check, the wait for the first word, and the judge cost
- Every item. An item is one fact, event, summary, retrieval query, Chat question, or Dream source, and its id reads `<person>/<kind>/<number>`, such as `sam-example/retrieval/1`. A Dream source reads `<person>/dream/<entry stem or chat-N>`, such as `sam/dream/2026-09-03-lost-mia`. It holds its status, its checks with a reason for each, the Chat turns with their tool calls and timings, and a note.

## Hard, counted, and soft checks

One report holds three kinds of result:

- **Hard checks** fail the setup. One failure is enough.
- **Counted checks** add up. They never fail a setup by themselves, and fewer is better.
- **Soft checks** are recorded but never fail anything or count. Judge verdicts and rank scores are soft.

These run now:

| Check | Kind | Fails when |
| --- | --- | --- |
| Fast enough (`fast-enough`) | Hard | The median wait for the first visible word is over `speedLimitSeconds`, or the slowest 10% is over `p90LimitSeconds` when the sweep sets it |
| No severe unsupported claim (`no-severe-unsupported`) | Hard | Something Dream wrote from a source claims or implies death, suicide, self-harm, abuse, or violence that the source does not support |
| Dream supported (`dream-supported`) | Counted | Something Dream wrote from a source makes another claim that the source does not support |
| Turn works (`turn-works`) | Counted | A Chat turn does not finish, waits for input, returns an empty reply, leaks `<think>` or tool-call syntax, or runs a different model than the setup asked for |
| Retrieval top hit (`retrieval-top-hit`) | Counted | The expected entry is not the first search hit. The check records the entry’s rank. |
| Summary exists (`summary-exists`) | Counted | Dream wrote no summary for the entry |
| Memory returns (`memory-returns`) | Counted | Memory search returned nothing for a fact or event. Memory-on setups only. |
| Event source (`event-source`) | Counted | No event hit comes from the expected entry. Memory-on setups only. |

The two Dream accuracy checks belong to a Dream source, so each source is one item. A failed check names the claim: the kind of item that holds it, the exact words, and what the source says instead. Setups that share a Dream snapshot share these items, and the judge cost of the snapshot is split among them.

The judge’s scores for facts, events, current state, summaries, and Chat replies are soft, and so are the retrieval rank, the check that the current wording ranks above the stale one, and the Chat search checks. They appear in an item’s `note`, for example `Reference scores: retrieval-rank 0.50.` A judge score is 1 for a pass and 0 for a fail.

A counted check’s rate is its failures divided by the items graded for that check. The setup’s counted rate is all counted failures divided by the items graded, so it can pass 1.

The hard check `fits-in-memory` is in the report schema, but the runner does not measure swap yet. It never fails a setup, and the swap fields in the summary stay `null`.

## Graded, not graded, and skipped

Every item has one of three statuses:

- **Graded**: the checks ran and have results.
- **Not graded**: the judge could not give a verdict, or the item never reached the judge. The reason is “not graded: spending cap”, “not graded: judge error: …”, or “not graded: no price for …”. A Chat reply with no grade pass counts too. A judge error is never a failure.
- **Skipped**: the check does not apply, such as a memory check in a memory-off setup.

A setup with any item that is not graded is marked incomplete in the ranking. Skipped items are left out of the rates.

## The ranking

`<sweep id>.sweep.json` lists the setups best first, and the runner prints the same list when it finishes. The order is:

1. Setups that pass every hard check come first. The rest follow, with the hard checks they failed.
2. Within each group, the lowest rate of counted failures per graded item ranks first.
3. Then the highest rubric mean. Means within 0.05 tie. A tie goes to the lower spread across repeats, then the lower median wait for the first word.

An incomplete setup ranks after every complete one, even a complete one that failed a hard check.

Rubric scores do not exist yet, so for now setups with the same counted rate rank by the wait for the first word.

## The judge check result

The judge check runs before any setup, so no setup report holds it. `<sweep id>.sweep.json` holds its result under `judgeCheck`: `passed`, and `misses`, a list of `{ check, kind, itemId, detail }`. A sweep that stops on a miss or an unchecked judge writes no reports, so `passed` is `true` in every sweep file. [The judge check](evals.md#the-judge-check) explains what stops a sweep.

The check’s rows are in `agent/evals/.runs/<sweep id>/judge-check/judge-check.results.jsonl`, with its log beside them. To see each item’s verdict and what the judge found:

```sh
jq -r '.assertions[] | select(.name == "hard:judge-check") | "\(.metadata.itemId) passed=\(.passed) found=\(.metadata.found) \(.metadata.reason // "")"' agent/evals/.runs/<sweep id>/judge-check/judge-check.results.jsonl
```

## Reading a failure

Start with the end-of-run list or `<sweep id>.sweep.json`, which names each setup’s id and the hard checks it failed. Open that setup’s report next. `summary.hardFailures` gives a count and a detail line, such as “median wait for the first word was 24.1 s, over the 20 s limit”.

For counted failures, list the items whose checks failed. Each failed check carries a reason:

```sh
jq '.items[] | select(any(.checks[]; .outcome == "fail")) | {itemId, failed: [.checks[] | select(.outcome == "fail")]}' agent/evals/reports/<sweep id>__<setup id>.report.json
```

The report keeps a judge score but not the judge’s reasons. To read a reason, open the pass’s rows under `agent/evals/.runs/<sweep id>/`. Grade rows for a setup are in `setups/<setup id>/<person>/grade.results.jsonl`, and person rows are in `dream/<snapshot id>/<person>/person.results.jsonl`:

```sh
jq -r '.assertions[] | select(.name | startswith("soft:")) | "\(.name) \(.score) \(.metadata.reason)"' agent/evals/.runs/<sweep id>/setups/<setup id>/<person>/grade.results.jsonl
```

For a Dream accuracy failure, the failed check’s `reason` and `evidence` hold the first claim. The person pass’s rows also hold the source, everything Dream wrote from it, and every claim, in the `dream-source` score of each source. This lists them for one person:

```sh
jq -r 'select(.metadata.kind == "dream-source") | .assertions[] | select(.name == "soft:dream-source") | .metadata.dream | "== \(.sourceId)", (.written[] | "[\(.itemKind)] \(.text)"), (.unsupportedClaims[] | "  \(.severity): \"\(.quote)\" \(.reason)")' agent/evals/.runs/<sweep id>/dream/<snapshot id>/<person>/person.results.jsonl
```

The [report viewer](../../eval-viewer/README.md) shows the same data without the commands.

## Fixing runner failures

These are listed in the order you are likely to hit them:

- **“make eval controls the target URL; do not pass --url in ARGS.”**: remove `--url`. Exit code 2. The runner also refuses `--max-concurrency`, `--json`, `--junit`, and `--list`, and it names the option.
- **“No sweep file …” or “… is not a sweep name.”**: the first message lists the sweeps in `agent/evals/sweeps/`. A name uses lowercase letters, digits, and dashes.
- **“Invalid sweep file …”**: the lines below name the key and what is wrong with it.
- **“Thinking … is not supported yet.”**: use `on` or `off`. The agent turns thinking on or off and has no levels.
- **“The eval data has problems:”**: each line names a person and a problem, such as an entry dated after 2026-11-15, or a reference that matches no entry. Fix the person’s files, as [Eval fixtures](../../agent/evals/data/README.md#checking-a-person) explains.
- **“No person matches the sweep’s tags”** or **“No eval files match the tests”**: the sweep selects nothing. Check `tags` and `tests`. A test that names an eval file that does not exist yet is listed as “Eval files that do not exist yet”.
- **“No Chat prompt file …”**: a `prompts` value has no file. `baseline` always works, and any other name needs `agent/evals/prompts/<name>.md`.
- **“eve info failed in …” or “The root … is not ready:”**: a Chat prompt root did not load. The lines below say what eve reported, such as a missing tool or a build error.
- **“The sweep’s Dream prompts have problems:”**: each line names a `dreamPrompts` folder in `agent/evals/dream-prompts/` and what is wrong with it. It has no folder, holds none of `summary.md`, `chat-summary.md`, `chat-title.md`, and `extract.md`, holds a file Dream does not read, or holds a prompt file Sage will not use (an empty one, one that is not a regular file, or one of 64 KiB or more). Sage would keep the built-in prompt for each of these, so the runner stops instead. Exit code 2.
- **“The judge check missed”**: the judge let a planted failure through, or flagged a clean item. Each line gives the kind (`missed` or `false-alarm`), the check, the item, and what the judge did. Fix the rubric or the item’s label in `agent/evals/judge-check/`, then run again. The sweep stopped before it pulled, built, or seeded anything. Exit code 1.
- **“The judge could not be checked”**: an item of the judge check came back not graded, so the check proves nothing. The line names the item and the reason, such as “not graded: spending cap” or a gateway error. Check the gateway key and your connection, then run again. Exit code 1.
- **“Port 11436 is already in use.”**: stop `make dev` or another eval, then run again.
- **“Ollama did not start on 127.0.0.1:11436.”**: the temporary server that checks and pulls models did not answer. Its log follows the message.
- **“Could not get the pinned Ollama build.”**: the download or checksum failed. The lines above say which step.
- **“Model problems:”**: each line names a model. A chat model with no tools, or a summary or embedding model that cannot do its job, stops the run. A model that is still missing after the pull is listed too.
- **“Could not pull … (ollama exit …).”**: a pull failed. Check the model name and your connection.
- **“No AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is set …”**: add a gateway key to `agent/.env.local`. Exit code 2.
- **“Not a terminal, so there is nobody to ask. Pass --yes to run.”**: add `--yes` to `ARGS`. Exit code 2.
- **“native build failed for memory … (exit …). Log: …”**: the Sage build failed. The log is in `agent/evals/.runs/<sweep id>/logs/`.
- **“Sage did not write agent-server.json”**, **“Sage did not write its automation folder”**, **“Sage exited before it was ready.”**, or **“Sage automation did not become ready.”**: the throwaway app failed to start. The message ends with the tail of its log, and the full `.sage.log` is in the reports folder.
- **“Bridge … did not finish.”**: the app stopped answering bridge commands while seeding. The Sage log shows what it was doing last.
- **“Seeding … failed”**: read `seed.log` in `agent/evals/.runs/<sweep id>/dream/<snapshot id>/<person>/`.
- **“Dream had nothing to process.”**: seeding saved no entries. Check that the person has `.md` entries.
- **“Dream did not finish before the timeout.”**: Dream gets 30 minutes, or 2.5 minutes for each entry when that is longer. A slow or missing summary model is the usual cause. The Sage log shows progress lines.
- **“The eval agent server did not report a port” or “did not answer /eve/v1/health”**: a Chat server failed to start. Its log follows the message.
- **“Ollama is still answering on 127.0.0.1:11436 after Sage stopped.”**: another Ollama took the port. Stop it, then run again.
- **“… crashed (exit …)”** or **“… failed: …”**: one unit failed. The sweep goes on, the runner lists these at the end, and it exits with code 1. The pass’s log is in `agent/evals/.runs/<sweep id>/`.
- **“Entry N summary is encrypted.”**: the eval read an encrypted row. Eval runs use a throwaway journal with encryption off, so something pointed the run at a real data directory.
- **“not graded: spending cap”**: the sweep passed `spendingCapUsd`, so the rest went ungraded. Raise the cap and run again.
- **“not graded: judge error: …”**: the judge call failed. If every item says this, check the gateway key and your connection. The text after it is the gateway’s own message.
- **Old results after you edit a person’s entries**: the Dream cache key covers the person’s entries, so editing them runs Dream again. If you suspect a bad snapshot, skip it once with `SAGE_EVAL_CACHE=0 make eval` or delete `agent/evals/.cache/`.

## Viewing reports

`make eval` asks about uploading at the end of a run, and `make eval-upload` uploads earlier reports later. [Eval suite](evals.md#uploading-reports) covers the tokens and settings.

The Next.js app in `eval-viewer/` lists sweeps and runs, ranks the setups of a sweep, and opens one report per setup. [The eval viewer README](../../eval-viewer/README.md) explains how to run it.
