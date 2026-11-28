# Speech library

`SageSpeech.swift` is the dictation engine, built on Apple's SpeechTranscriber. Read `docs/dictation.md` first.

## Rules

- The library targets macOS 26, and Sage runs on macOS 11. So Sage loads it at run time and never links it.
- These change together:
  - `abiVersion` here and in `src/speech_apple.zig`;
  - the 8 `@_cdecl` exports here and the names in `src/speech_apple.zig`;
  - the `-eq 8` symbol count and the `swiftc` flags in the `speech` job of `.github/workflows/ci.yml`;
  - `addSpeechLibrary` in `build.zig`;
  - the `macos-26` runner in both workflows.
- Keep the `.fastResults` reporting option. Without it, text shows up about 3.5 seconds late.
- No audio is kept, and none reaches the web view.
- `make dev` gets the microphone permission of the app that launched it. Test dictation from macOS Terminal, not from an agent's shell.
- Build without the library with `-Dspeech=false`.

## Skills

- `swift-concurrency`, pinned at https://github.com/avdlee/swift-concurrency-agent-skill/tree/3b1580d8398e0b5408b3bf0bada0e941a1cfc642/skills/swift-concurrency: tasks, actors, and `Sendable` in this file.
