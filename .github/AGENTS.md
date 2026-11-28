# Workflows

`ci.yml` runs on pushes and pull requests to `main`. `release.yml` runs on `v*` tags and publishes the app. Read `docs/release.md` before you change either one.

## Rules

- Both workflows install the same way: Zig 0.16.0, Node 24, the Native SDK CLI from `.native-sdk-version` with `npm install -g --ignore-scripts`, and each package's dependencies. Change both together.
- CI calls make targets (`make check`, `make test`, `make fe-build`). Put new logic in the `Makefile`, not in a workflow step.
- The `speech` job and the release job need the `macos-26` runner for the macOS 26 SDK.
- A workflow change is proven only when it runs on GitHub. Try a `release.yml` change with an rc tag first. An rc tag doesn't change the version in `app.json`, and a tag can't be reused after its run fails.
- A flaky test on `main` gets fixed. A rerun isn't a fix.
- GitHub's API sometimes answers 503, and `gh pr checks --watch` can die on a timeout. Wrap `gh` calls that wait in a retry loop.

## Skills

- `github-actions-hardening`, pinned at https://github.com/github/awesome-copilot/tree/93fc8b9ee3ef56b9b5e7261e6ce92d314cb2c1cf/skills/github-actions-hardening: triggers, token permissions, and pinning actions.
