# Eval reports

This page explains what `make eval` writes, how to read it, and how to fix the failures you are most likely to hit. To run the suite first, see [Eval suite](evals.md).

## Where reports go

Each run writes to `agent/evals/reports/`. Each trio in a sweep gets three files, named with a run id built from the summary model, the embedding model, the chat model, and the UTC start time. Slashes and colons in model names become underscores, so the default models give an id such as `qwen3.5_9b__nomic-embed-text__qwen3.5_9b__20260916T011701Z`.

- `<run id>.xml`: the JUnit results, with one Chat test case per question
- `<run id>.sage.log`: what the throwaway Sage printed while it ran
- `<run id>.manifest.json`: the journal ids the seed step wrote, so you can trace a case back to database rows

Each Chat test case carries the judge score: in `<system-out>` when it passes, or in the `<failure>` body when it fails. Passing Chat cases also include the reply text. The report viewer lists these under Chat scores.

Older files that omit the chat model from their name still open in the report viewer.

## Hard checks and judge scores

One JUnit file holds two kinds of result:

- **Hard checks** fail the test case: retrieval returns the right entry as the top hit, Chat finishes a turn, a summary exists, memory returns a fact or event, and each event’s `sourceId` matches its seeded entry.
- **Soft checks and judge scores** are recorded but do not fail the run: the judge’s factuality and summary scores, the check that current wording ranks above stale wording, and the check that Chat called `search_journal` or `facts__search_memories`.

Use hard checks to decide whether a run is broken. Compare judge scores across runs. [Eval suite](evals.md#comparing-models) explains how to run several models at once.

## Fixing runner failures

These are listed in the order you are likely to hit them:

- **“Ollama is not running at `http://127.0.0.1:11434`.”**: start Ollama and run again.
- **“Missing curl” (or ollama, native, node)**: install that tool. `make dev` needs the same set.
- **“Sage exited before it was ready”, “Sage did not write agent-server.json”, “Sage did not create its automation folder”, or “Sage automation did not become ready.”**: the throwaway app failed to start. Read `<run id>.sage.log` in the reports folder for the reason.
- **“Bridge … did not finish.”**: the app stopped answering bridge commands while seeding. The Sage log shows what it was doing last.
- **“Dream had nothing to process.”**: seeding saved no entries. Check that `agent/evals/data/` has cases and that the seed step printed `seeded <case>: <ids>` lines.
- **“Dream did not finish before the timeout.”**: Dream gets 30 minutes, and a slow or missing summary model is the usual cause. The Sage log shows progress lines.
- **“Entry N summary is encrypted.”**: the eval read an encrypted row. Eval runs use a throwaway journal with encryption off, so something pointed the run at a real data directory.
- **Old results after you edit a case**: the Dream cache key covers the dataset, so editing a case runs Dream again. If you suspect a bad snapshot, skip it once with `SAGE_EVAL_CACHE=0 make eval` or delete `agent/evals/.cache/`.

## Viewing uploaded reports

`make eval` asks about uploading at the end of a run, and `make eval-upload` uploads earlier reports later. [Eval suite](evals.md#uploading-reports) covers the tokens and settings.

The Next.js app in `eval-viewer/` lists uploaded reports and opens one report per trio. [The eval viewer README](../../eval-viewer/README.md) explains how to run it.
