# Eval viewer

This Next.js app shows the reports that `make eval` writes. It lists sweeps and recent runs, ranks the setups of a sweep, puts two setups side by side, reads a conversation with the judge's reasons, shows what Dream wrote next to its source, and lets you grade a sample of replies by hand. [Eval reports](../docs/agent/evals-reports.md) explains what each report holds.

## Where reports come from

The app reads reports from one of two places:

- **Vercel Blob**: when `BLOB_READ_WRITE_TOKEN` is set, or both `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` are set. Use the same store as `make eval-upload`.
- **A local folder**: otherwise, `../agent/evals/reports`, or the folder in `SAGE_EVAL_REPORTS`

The app sorts files by their ending:

- **A run** is three files with the same run id: `<run id>.xml`, `<run id>.sage.log`, and `<run id>.manifest.json`. These are the old JUnit runs, and they still open.
- **A sweep** is one `<sweep id>.sweep.json` with the ranking, plus one `<sweep id>__<setup id>.report.json` for each setup.

A sweep needs its `.sweep.json` to show up. A ranked setup with no report file still shows, with its setup id and no link.

The app reads the JSON on its own and does not import code from `agent/`. It reads `schemaVersion` 1. A file with another version, or a field of the wrong type, shows an error where the report would be. Fields it does not know are ignored, and a field a report leaves out is filled in.

## Pages

- **Sweep** (`/sweeps/<sweep id>`): the ranking. Each row shows the hard checks that failed, the counted-failure rate, the rubric mean and spread, the first word's median and p90, swap growth, cost, and whether every item was graded. Click a heading to sort by it. The sort is in the address, so you can share it. A short legend explains how the runner ranks. Pick A and B in the last column to compare two setups.
- **Compare** (`/sweeps/<sweep id>/compare?a=<setup id>&b=<setup id>`): the two setups' numbers, then each item with both setups' replies, or conversations, side by side. Each side lists its checks with tier, outcome, reason, and the quoted evidence, then its rubric scores with their reasons. Passed and skipped checks are folded away. Filter by person, kind, and expect, or show only the items where a setup failed a check.
- **Setup** (`/sweeps/<sweep id>/setups/<setup id>`): one setup's summary, its counted, slip, and search checks, and its items. Open an item in the reader.
- **Reader** (`/sweeps/<sweep id>/setups/<setup id>/item?id=<item id>&repeat=<n>`): every turn of one item. It shows the person's messages, Sage's replies with timing, tool calls folded away, the checks and rubric scores of each reply, and the conversation's own scores. It marks the exchanges where the person returned to a worry, where Sage fed the loop, where the person said no, and where the reply brought it back. It also marks the simulated user's slips after a crisis.
- **Dream accuracy** (`/sweeps/<sweep id>/setups/<setup id>/dream`): for each person and source, the entry or chat next to everything Dream wrote from it. Each unsupported claim is marked in the text, with its severity and the judge's reason. Filter by person, or show only the sources with claims.
- **Grade by hand** (`/calibration`): the grading form. It is in the header only under `make eval-viewer-dev`.

Reports record each item's `expect`, and a conversation turn can have its own. The viewer reads both, so the Expect filter on the compare page works. Dream and person-pass items have no `expect`.

## Grading by hand

The judge check and the agreement check compare the judge with your grades. The form grades a calibration sample.

1. Write a sample with `agent/scripts/eval/calibration-sample.ts`. It saves `agent/evals/content/calibration/sample-<name>.json`.
2. Run `make eval-viewer-dev` and open [localhost:3000/calibration](http://localhost:3000/calibration).
3. For each item, answer each check with Pass, Fail, or N/A, and each rubric item with 1 to 5 or N/A. Add a note if you like. Click an answer again to clear it.

An item counts as graded when every check and rubric item has an answer, N/A included. The form shows how many items are graded, and it saves each change after a short pause. Come back later and it picks up where you stopped.

Grades go to `agent/evals/content/calibration/grades.jsonl`, one line for each item. Pass is `true`, Fail is `false`, and N/A is `null`:

```json
{"sampleId":"2026-11-12T010000Z-screen","id":"a1b2c3d4e5:sam/opener/rent-panic:r1:t1","grader":"human","checks":{"crisis-handled":true,"no-overreach":false},"rubric":{"warmth":4,"right-help":null},"note":"","gradedAt":"2026-11-16T10:00:00.000Z"}
```

A check or rubric item with no answer has no key. Saving a grade again replaces its line. Every other line stays as it was.

Saving works only under `next dev`, which `make eval-viewer-dev` runs. A production build refuses to save and hides the form. The save also refuses to write outside the repo, after it follows links, and it checks every answer against the sample on disk.

The sample file holds `sampleId` and a list of `items`. Each item has `id`, `setupId`, `itemId`, `person`, `kind`, `expect`, `message`, `reply`, an optional `context` of any shape, and the `checks` and `rubric` ids to grade. The form skips fields it does not know.

## Running it

1. Install dependencies with `npm --prefix eval-viewer install`, or `make setup` for the whole repo.
2. Copy `eval-viewer/.env.example` to `eval-viewer/.env.local`, and set `BLOB_READ_WRITE_TOKEN` there to read from Blob.
3. Start the app with `make eval-viewer-dev`, then open [localhost:3000](http://localhost:3000).

For a production build, run `make eval-viewer-build`, then `make eval-viewer-start`.

## Settings

All settings are optional and go in `eval-viewer/.env.local`:

- `BLOB_READ_WRITE_TOKEN`: reads reports from Vercel Blob
- `SAGE_EVAL_BLOB_PREFIX`: the folder in the store, `sage-evals` by default
- `SAGE_EVAL_BLOB_ACCESS`: `private` by default. Set it to `public` only if the reports were uploaded as public.
- `SAGE_EVAL_REPORTS`: the local folder to read when no Blob token is set
- `SAGE_EVAL_CONTENT`: the eval content folder, `../agent/evals/content` by default. The grading form reads and saves in its `calibration` folder, and saving stays inside that folder.
- `SAGE_EVAL_CALIBRATION`: the folder with the calibration samples and `grades.jsonl`, `../agent/evals/content/calibration` by default. Saving still needs it inside the repo.

## Code layout

- `app/`: the home page, `app/runs/[id]/` for one run, and `app/sweeps/[id]/` for one sweep, with `compare/`, `setups/[setupId]/`, `setups/[setupId]/item/`, and `setups/[setupId]/dream/` below it. `app/calibration/` holds the grading form and its server action.
- `components/`: the dashboard, model comparison, run report, sweep ranking, setup report, compare, reader, Dream accuracy, and grading views
- `lib/load-reports.ts`: picks Blob or the local folder, sorts the files, and loads runs, sweeps, and setups
- `lib/reports/`: parses the JUnit XML, the Sage log, and the manifest, and builds the model comparison
- `lib/reports/sweep-types.ts`, `sweep-parse.ts`: the types and the tolerant parser for the JSON files. Keep the types in step with `agent/evals/lib/schema.ts`.
- `lib/reports/sweep-view.ts`: setup labels, links, and the ranking sort
- `lib/reports/item-view.ts`: flat check rows, exchanges, and marks for one item
- `lib/reports/compare.ts`: pairs the items of two setups and filters them
- `lib/reports/dream-view.ts`: groups Dream sources by person and marks each claim in the text
- `lib/reports/calibration.ts`, `calibration-store.ts`: the sample and grade shapes, and the files behind the form, with the save guard
- `lib/reports/file-names.ts`: tells run, sweep, and setup files apart by their ending
- `lib/reports/sweep-samples.ts`: a sample sweep, setup reports, and a calibration sample for the tests

## Checks

Run these from the repo root after you change the app:

```sh
npm --prefix eval-viewer run check
npm --prefix eval-viewer run typecheck
npm --prefix eval-viewer test
npm --prefix eval-viewer run build
```

`make test` runs the unit tests in `lib/reports/`. To see the pages without a sweep, write the files from `sampleFiles()` in `lib/reports/sweep-samples.ts` into a folder, and set `SAGE_EVAL_REPORTS` to it. To try the grading form, write `sampleCalibration()` as `sample-<name>.json` into a folder inside the repo, and set `SAGE_EVAL_CALIBRATION` to it. The app uses shadcn/ui, so add components with `npx shadcn@latest add <component>` from this folder.
