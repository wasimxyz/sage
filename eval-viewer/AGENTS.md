# Eval viewer

The Next.js app that ranks sweeps and opens eval reports. Read `eval-viewer/README.md` and `docs/agent/evals-reports.md` first.

## Next.js

This app runs Next.js 16.4, which changed APIs that most training data predates. Before you use a Next.js API you're unsure about, read its guide in `eval-viewer/node_modules/next/dist/docs/`.

`next.config.ts` sets `agentRules: false`, so `next dev` removes its own managed block from this file. Never add the `nextjs-agent-rules` marker comments here.

## Rules

- Don't import code from `agent/`. The viewer reads report `schemaVersion` 1 on its own.
- `agent/` tests import `lib/reports/*`, so those files import each other by relative path with `.ts`, and Node must be able to load them.
- `lib/reports/sweep-types.ts` follows `agent/evals/lib/schema.ts`, and `lib/reports/check-info.ts` follows `CHECK_TIERS`. Change them together.
- Neither CI nor `make check` builds this app. After a Next.js or dependency change, run `npm --prefix eval-viewer run build`.
- Grades save only under `make eval-viewer-dev`, and only to `calibration/` in the eval content.
- `components/ui/` is shadcn output. Add a component with `npx shadcn add <name>` in `eval-viewer/`.

## Checking changes

With `make eval-viewer-dev` running, use the `next-dev-loop` skill. It reads errors, logs, and routes from the dev server and drives the page with `agent-browser`.

## Docs

- Next.js: https://nextjs.org/docs/llms.txt, which may be ahead of 16.4. Prefer the bundled guides.
- Vercel, for Blob uploads from `make eval-upload`: https://vercel.com/docs/llms.txt

## Skills

- `next-best-practices` (vercel-labs/openreview): file conventions and Server Component boundaries.
- `next-upgrade` (vercel-labs/openreview): upgrading Next.js.
- `next-dev-loop` (vercel/next.js): checking a change in the running app.
- `agent-browser` (vercel-labs/agent-browser): driving a real browser for `next-dev-loop`.
- `vercel-react-best-practices` (vercel-labs/agent-skills): components and data fetching.
- `shadcn` (shadcn/ui): adding and composing shadcn components.
