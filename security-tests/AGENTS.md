# Security tests

These tests pin what Sage protects. Read `docs/security/README.md` and `docs/security/testing.md` before you change one.

## Rules

- Most tests read source files by path and match their text. When you move, rename, or reword the code a test reads, update the test in the same change.
- `make test` finds `*.test.ts` files by glob. A new `.sh` runs only after you add it to the `test` target in the `Makefile`.
- These files have no `tsconfig.json` or lint config, so `make check` doesn't cover them. Run them with `node --test --experimental-strip-types security-tests/*.test.ts`.
- They need no network and no Ollama, and they never start a model.
- Add each new test to the list in `docs/security/testing.md`.

## Skills

- `security-best-practices` (openai/skills): reviewing a change to the lock, encryption, the agent server, or the packaged app.
