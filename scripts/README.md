# Scripts

These shell scripts package the Mac app and run the eval suite. Each section names the `make` command that runs them.

The seeding and grading steps live in `agent/scripts/`. The canirun catalog refresh lives in `frontend/scripts/`, as [Models](../docs/models.md#how-recommendations-work) explains.

## Packaging

`make package` builds the app, then runs `copy-agent-into-app.sh`. `zig build package` runs that same script and passes the app path.

`copy-agent-into-app.sh` copies the built Chat agent into `Sage.app`. Before it finishes, it runs the two scripts below, checks that the copied Chat channel still allows `zero://app` (the address the packaged app uses to call Chat), and signs the app again so the copy still opens.

1. `refuse-packaged-dev-modules.sh` stops the copy when `typescript`, `@types`, or `@vercel/blob` is still installed in the copied agent.
2. `fetch-node.sh` downloads Node.js 24.21.0 once into `third_party/node/`, checks that the download is the expected file, and copies the `node` program into the app.

`make package-archive` runs `archive-packaged-app.sh` after that copy. The script builds `zig-out/package/Sage-0.1.0-macos.dmg` from the app that already contains the Chat agent and Node.js.

## Eval

`make eval` runs `eval-run.sh`. The runner loads settings, grades Dream and Chat, writes reports under `agent/evals/reports/`, and then asks whether to upload them. The full sequence is in [Eval suite internals](../agent/evals/README.md).

`eval-run.sh` and `eval-upload.sh` both load settings through `eval-env.sh`, which reads `agent/.env`, then `agent/.env.local`. A variable already set in the shell keeps its value.

`make eval-upload` runs `eval-upload.sh` on its own, to upload reports from an earlier run. On a terminal it asks first, and the default is no. When input is not a terminal, it skips the upload.

`make test` runs `eval-env.test.sh`. That check confirms the load order above.
