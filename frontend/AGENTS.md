# Frontend

React 19, Vite 8, TypeScript 5.9, Tailwind 4, and shadcn (`base-nova`, on Base UI), running in the system web view, which is WebKit. Read `docs/journal.md` for the editor and sidebar, and `docs/agent/frontend.md` for Chat.

## Tests

- Node runs the tests directly with `--experimental-strip-types`. A new `*.test.ts` runs only after you add its path to `scripts.test` in `frontend/package.json`.
- A file under test imports values by relative path with `.ts`, and uses `@/` only for `import type`.

## Rules

- The Native SDK rejects with the code `handler_failed` and puts the error name in the message. Read it with `handlerErrorMessage` from `src/bridge.ts`, and match names exactly.
- Saves and imports send one chunked save at a time. Chat never saves while a reply streams.
- Opening or switching an entry is not an undoable edit, and never saves one entry's text into another.
- Every `@tiptap/*` package is pinned to one exact version. Bump them together.
- Global shortcuts wait while a dialog or menu is open (`hasOpenSurface` in `src/lib/open-surface.ts`).
- A lazy chunk gets an error boundary, so a failed load can't blank the window.
- Keep context values stable, and measure re-renders when you change a provider.
- Date logic uses the local day. Test midnight, waking from sleep, time zones, and daylight saving time.
- The CSP in `index.html` allows no inline script. The packaged Chat origin, `http://127.0.0.1:2001`, also appears in `src/lib/chat/eve-host.ts` and `src/eve_sidecar.zig`.
- The web view uses no audio APIs: no `getUserMedia`, `MediaRecorder`, or `AudioContext`.
- `eve` and `ai` move together with `agent/`. Read `agent/AGENTS.md` before you upgrade them.

## Styling

- Change only the theme the user names. A light-mode request leaves dark mode alone.
- Reuse the app's hover, selected, and dialog styles, and apply a style change to every matching control.
- `src/components/ui/` is shadcn output. Add a component with `npx shadcn add <name>` in `frontend/`. `src/components/ai-elements/` is registry code with local edits.
- `src/lib/canirun-catalog.json` comes from `npm --prefix frontend run catalog`. Don't edit it by hand.

## Checking changes

- To run the frontend without the native app, start Vite on port 5174 with `window.zero` stubbed. Keep the stub in your scratchpad, never in the repo. The parsers in `src/bridge.ts` give each response shape.
- A hidden browser pane fires no animation frames, observers, or scroll events, so a pass there proves nothing about them.
- The built-in browser is Chromium. Check caret, focus, text input, and vibrancy in `make dev`, which runs WebKit, or say in the PR what you didn't check there.

## Docs

- Base UI: https://base-ui.com/llms.txt
- Motion: https://motion.dev/llms.txt
- TipTap: https://tiptap.dev/llms.txt. Match the version pinned in `package.json`.
- Streamdown: https://streamdown.ai/llms.txt
- eve and `ai`: `frontend/node_modules/eve/docs/` and `frontend/node_modules/ai/docs/`, which match the installed versions.

## Skills

- `vercel-react-best-practices` (vercel-labs/agent-skills): components, rendering, and performance.
- `vercel-composition-patterns` (vercel-labs/agent-skills): component APIs and variants.
- `shadcn` (shadcn/ui): adding and composing shadcn components.
- `tiptap` (ueberdosis/tiptap): the editor in `src/components/editor.tsx` and its extensions.
- `streamdown` (vercel/streamdown): rendering Chat replies.
- `apple-design`, pinned at https://github.com/emilkowalski/skills/tree/64eb3deb9a5fbfa041faf783e0bc3fd635872e9c/skills/apple-design: springs, gestures, and motion.
- `web-design-guidelines` (vercel-labs/agent-skills): reviewing UI, only when asked.
