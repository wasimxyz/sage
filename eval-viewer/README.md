# Eval viewer

This Next.js app shows the reports that `make eval` writes. It lists sweeps and recent runs, compares models across runs, and opens one report per run with its failures and Chat scores. A sweep page ranks its setups, and a setup page lists its items with each check. [Eval reports](../docs/agent/evals-reports.md) explains what each report holds.

## Where reports come from

The app reads reports from one of two places:

- **Vercel Blob**: when `BLOB_READ_WRITE_TOKEN` is set, or both `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` are set. Use the same store as `make eval-upload`.
- **A local folder**: otherwise, `../agent/evals/reports`, or the folder in `SAGE_EVAL_REPORTS`

The app sorts files by their ending:

- **A run** is three files with the same run id: `<run id>.xml`, `<run id>.sage.log`, and `<run id>.manifest.json`.
- **A sweep** is one `<sweep id>.sweep.json` with the ranking, plus one `<sweep id>__<setup id>.report.json` for each setup.

A sweep needs its `.sweep.json` to show up. A ranked setup with no report file still shows, with its setup id and no link.

The app reads the JSON on its own and does not import code from `agent/`. It reads `schemaVersion` 1. A file with another version, or a field of the wrong type, shows an error where the report would be. Fields it does not know are ignored.

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

## Code layout

- `app/`: the home page, `app/runs/[id]/` for one run, `app/sweeps/[id]/` for one sweep, and `app/sweeps/[id]/setups/[setupId]/` for one setup
- `components/`: the dashboard, model comparison, run report, sweep ranking, and setup report views
- `lib/load-reports.ts`: picks Blob or the local folder, sorts the files, and loads runs, sweeps, and setups
- `lib/reports/`: parses the JUnit XML, the Sage log, and the manifest, and builds the model comparison
- `lib/reports/sweep-types.ts`, `sweep-parse.ts`: the types and the tolerant parser for the JSON files. Keep the types in step with `agent/evals/lib/schema.ts`.
- `lib/reports/file-names.ts`: tells run, sweep, and setup files apart by their ending
- `lib/reports/sweep-samples.ts`: a sample sweep and setup reports for the tests

## Checks

Run these from the repo root after you change the app:

```sh
npm --prefix eval-viewer run check
npm --prefix eval-viewer run typecheck
npm --prefix eval-viewer test
```

`make test` runs the unit tests in `lib/reports/`. To see the sweep pages without a sweep, call `sampleFiles()` from `lib/reports/sweep-samples.ts`, write each file into a folder, and set `SAGE_EVAL_REPORTS` to it. The app uses shadcn/ui, so add components with `npx shadcn@latest add <component>` from this folder.
