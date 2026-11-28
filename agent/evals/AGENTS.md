# Evals

Read `docs/agent/evals.md` to learn what the suite measures, then `agent/evals/README.md` before you change the runner or an eval file.

## Never run evals

Only the user runs evals. A run costs cloud money and hours of the Mac's time. Don't run `make eval`, `agent/scripts/eval/run.ts`, `npm --prefix agent run sweep` or `eval`, `--dry-run`, or `--help`, and never ask a subagent to. The runner exits with code 2 when `CLAUDECODE` is set. Check your change with unit tests and offline scripts, and say when it needs a real run.

## The eval content

- People, prompts, judge-check items, calibration grades, and sweeps live in the private sage-evals repo. Sage reads them from `agent/evals/content/`, a gitignored checkout, or from `SAGE_EVAL_CONTENT`. Never commit them to this repo, and never quote them in a PR.
- Name sage-evals in plain text. Don't link into it, because the link breaks for everyone else.
- A test that reads the content uses `skipWithoutContent()`. A test with its own fixtures clears `SAGE_EVAL_CONTENT`.
- A change to the `case.yaml` format changes `agent/evals/lib/schema.ts` and the content together. The PR names the content commit.

## Rules

- A new check needs its id in `CHECK_TIERS`, a `recordCheck` call, a test, and an entry in `eval-viewer/lib/reports/check-info.ts`.
- An eval file loads cheaply and never throws while it loads. It sends turns with `sendTurn`, never `.send(`, and records only through `lib/record.ts`.
- `rubricHash()` must cover every line of judge prompt text.
- `dreamSourceFiles` and `seedSourceFiles` in `lib/cache.ts` list every file that changes what Dream reads, seeding scripts included.
- When the judge model, the simulated-user model, or a sweep changes, update the cost estimates in their tests and in `docs/agent/evals.md`.
- The AI Gateway key goes in `agent/.env.local` or `eval-viewer/.env.local`. Keep it out of tracked files, uploads, and logs.
- A change to the report shape changes the runner and `eval-viewer/lib/reports/` together, and keeps `agent/scripts/eval/viewer-report-roundtrip.test.ts` passing.
- The runner pins `SAGE_TODAY` to 2026-11-15. Check relative dates in cases and prompts against it.

## Skills

- `eve` (vercel/eve): eval files, `eve eval`, and the result recorder.
