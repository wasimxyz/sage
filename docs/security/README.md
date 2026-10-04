# Security at a glance

This page explains what Sage protects, what it leaves readable on purpose, and where each protection lives in the code. Read it first, then the linked pages for each part.

Sage stores the journal, chats, and memories in one SQLite file named `app.db` on your Mac. Chat and Dream call Ollama’s local `/api` routes, which do not keep a copy of that data. Sage skips models Ollama marks as cloud-hosted, and the Chat agent refuses one even if a request names it.

Two protections guard `app.db`:

- **The lock**: when it is on, Sage asks for your password or Touch ID at launch and after sleep or idle time. See [The app lock](lock.md).
- **Encryption**: entry text, chats, memories, and Chat instructions stay unreadable in the file until you unlock. See [Encryption at rest](encryption.md).

Both use the same password or Touch ID. You can also turn on encryption with Touch ID alone and no password. Sage then makes a recovery key that you save once, as the backup if the Keychain copy of the key is lost; see [Recovery](recovery.md).

## What someone with the file can see

With encryption on, a person who copies the database file cannot read your entries or chats. They can still see:

- **Dates, word counts, and chat settings**: these stay readable so the sidebar and chat resume stay fast.
- **Embedding and summary vectors**: these stay readable so search by meaning keeps working.
- **Old copies**: a copy made before encryption, such as an APFS snapshot or a Time Machine backup, can still hold old text. [Encryption at rest](encryption.md#scrubbing-old-bytes) covers what Sage removes from the live file.

## Where each part lives

- `src/lock.zig`: the password check, the wrong-guess wait, the Touch ID flag, and removing the password
- `src/session_lock.zig`: locking on sleep, on the screen saver, and after idle time
- `src/touchid.zig`: the Touch ID prompt, through Apple’s LocalAuthentication framework
- `src/vault.zig`: the data key, its password and recovery key slots, and field encryption
- `src/keychain.zig`: the Keychain copy of the data key for Touch ID
- `src/journal.zig`: encrypts on write and decrypts on read
- `src/agent_server.zig`: the Unix socket server that lets the Chat agent search and read the journal
- `src/eve_sidecar.zig`: starts the packaged Chat agent and, with encryption on, gives it a separate key for its session files
- `agent/agent/lib/workflow-guard.ts`: puts the agent-server token on eve’s `/.well-known/workflow/` routes
- `agent/agent/lib/bearer.ts`: the constant-time token compare and the `fetch` wrapper that adds the token
- `src/main.zig`: the bridge commands that tie the parts together
- `security-tests/`: tests for the token, origin, and packaging rules

`app.db` is the only SQLite file Sage opens. Packaged Chat session files live under `eve/` in the app data directory, and window size and position live in the Native SDK’s `windows.zon`.

The bridge rejects journal bodies over 1 MiB and single Chat events over 128 KiB.

## The rest of the security docs

- [The app lock](lock.md): the password, Touch ID, wrong guesses, and automatic locking
- [Encryption at rest](encryption.md): the data key, the key slots, the field format, and Chat workflow files
- [The Touch ID Keychain mirror](keychain.md): how Touch ID opens the data key without your password, and what protects that copy
- [Recovery](recovery.md): the recovery key and what to do when something breaks
- [Local agent server](agent-server.md): how Chat tools read the journal and how the Chat port checks the token
- [Testing the lock and encryption](testing.md): the unit suite, the security tests, and the automation server

[Models](../models.md#how-recommendations-work) explains the model grades in Settings, which come from a file in the app and never contact canirun.ai.
