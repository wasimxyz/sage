# Eval viewer

This Next.js app shows the reports that `make eval` writes. It lists recent runs, compares models across runs, and opens one report per run with its failures and Chat scores. [Eval reports](../docs/agent/evals-reports.md) explains what each report holds.

## Where reports come from

The app reads reports from one of two places:

- **Vercel Blob**: when `BLOB_READ_WRITE_TOKEN` is set, or both `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` are set. Use the same store as `make eval-upload`.
- **A local folder**: otherwise, `../agent/evals/reports`, or the folder in `SAGE_EVAL_REPORTS`

Each run is three files with the same run id: `<run id>.xml`, `<run id>.sage.log`, and `<run id>.manifest.json`.

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

- `app/`: the home page and `app/runs/[id]/` for one run
- `components/`: the dashboard, model comparison, and report views
- `lib/load-reports.ts`: picks Blob or the local folder and loads a run’s three files
- `lib/reports/`: parses the JUnit XML, the Sage log, and the manifest, and builds the model comparison

## Checks

Run these from the repo root after you change the app:

```sh
npm --prefix eval-viewer run check
npm --prefix eval-viewer run typecheck
npm --prefix eval-viewer test
```

`make test` runs the unit tests in `lib/reports/`. The app uses shadcn/ui, so add components with `npx shadcn@latest add <component>` from this folder.
