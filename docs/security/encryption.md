# Encryption at rest

This page explains how Sage encrypts the journal file: the keys, the storage format, and what happens when you turn encryption on, unlock, search, change your password, or turn encryption off. The code is `src/vault.zig` for the keys and `src/journal.zig` for reads and writes. Chat’s session files use `src/eve_sidecar.zig` and `agent/packages/world-encrypted-local`.

## What is encrypted

With encryption on, these fields are stored as ciphertext:

- Entry titles, bodies, and summaries
- The text stored next to each entry embedding
- Chat titles, each chat event, chat summaries, and the text next to each chat embedding
- Facts, events, and each memory’s `origin_text`
- Chat instructions from Settings > Agent

The file stays unreadable until you unlock Sage with the same password or Touch ID as the app lock, or with a recovery key if you made one. In a packaged app, Chat’s session files under `.eve/.workflow-data` are encrypted too, as [Chat workflow files](#chat-workflow-files) explains.

## The data key

Turning encryption on creates one random 32-byte data key, and this key encrypts every protected field. It lives only in memory while Sage is unlocked, and Sage zeroes it on quit. It is never written to disk in the clear.

## The key slots

The data key is stored wrapped, which means encrypted with another key. Each stored copy is a slot with its own wrapping key, and either slot opens the same data key. A journal needs at least one slot.

- **Password slot**: Argon2id turns your password into the wrapping key, with its own random salt and the settings OWASP recommends (19 MiB of memory and 2 iterations). The password must be at least 8 characters, because this key is what stands between a copied file and the data key.
- **Recovery slot**: a recovery key turns into a wrapping key the same way. The key is 120 random bits shown as 24 letters and numbers in six groups of four, like `7K2M-9QXD-3FHT-8VWZ-4BNC-6PRG`. Only the core generates it, and the web view can show a key but never choose one.

The recovery key leaves out letters people misread. When you type it, Sage reads O as 0 and I or L as 1, so a key copied off paper still works.

Only the wrapped keys are stored, in rows of the `app_setting` table:

- `enc.enabled`: the on flag
- `enc.kdf` and `enc.wrapped_key`: the password slot, as the salt and Argon2id settings in JSON, and the wrapped data key
- `enc.recovery_kdf` and `enc.recovery_wrapped_key`: the recovery slot, in the same form
- `enc.recovery_rotate`: set after an unlock with the recovery key, until you save a new one

A journal with only a recovery slot has no `enc.kdf` or `enc.wrapped_key` row. Versions of Sage from before recovery keys read that as encryption off, so open such a journal only in this version or newer. [Recovery](recovery.md#you-open-the-journal-in-an-older-sage) covers what happens if you do not.

Each slot carries its own label as authenticated data, so a password wrap pasted into the recovery rows fails to open, and the other way around. Sage writes a slot’s rows in one transaction, so a setup cannot half finish. If neither slot has both of its rows, Sage treats encryption as off.

## Rows that track unfinished work

- `enc.rewrite_pending`: the walk that encrypts or decrypts rows has not finished
- `enc.disable_pending`: a requested disable still needs to decrypt rows
- `enc.scrub_pending`: the file rebuild has not finished
- `enc.ciphertext_checked`: Sage has checked every prefixed field. Older vaults get a one-time rewrite after unlock, before data commands can run.

## Why the lock hash does not wrap the key

The lock’s password hash never wraps anything. That hash is stored in the same database, so a key made from it could be rebuilt from the file alone. The second Argon2id run keeps the two apart: the hash checks passwords, and the wrapping key protects the data key.

## How each field is encrypted

Each field is encrypted with AES-256-GCM. Three properties protect the result:

- **A fresh random nonce per field**: the same words encrypt differently every time.
- **A label naming the table and column**: a ciphertext moved to another field, such as from `journal_entry:body` to `journal_entry:title`, fails to open. Chat event labels also name the conversation and the event’s position, so a row moved within `chat_event` fails too.
- **A 16-byte authentication tag**: any changed byte fails to open.

The stored form is base64 text with a `sage:v1:` prefix. The prefix names the format, but Sage checks the authentication tag before it treats a field as ciphertext.

## Turning encryption on

If you already wrote entries, Sage rewrites them in place:

1. Settings asks for your password, and Sage checks it against the lock. With Touch ID alone, Settings asks for a fresh Touch ID prompt instead, shows a recovery key once, and asks you to type it back.
2. `Vault.enable` creates the data key, stores the setup rows, and marks the rewrite unfinished. With Touch ID alone, `Vault.enableWithRecovery` does the same with only the recovery slot.
3. With Touch ID on, Sage copies the data key into the Keychain, and a failed copy undoes the whole enable. Encryption with no password needs Touch ID, because the Keychain copy is how you open the journal day to day.
4. `Store.setRowsEncrypted` and the passes after it walk every table with protected fields, 32 rows at a time, and rewrite each field as ciphertext.
5. Sage checkpoints the write-ahead log and rebuilds the file, so old plaintext is gone from free pages. If that rebuild fails, `enc.scrub_pending` stays set and Sage retries before you can use the journal.

When you type the recovery key back, Sage keeps the key it generated and refuses any other.

The rewrite leaves each row’s `updated_at` alone, so embeddings and summaries do not go stale. If Sage quits partway, the next launch asks you to unlock, then finishes encrypting and rebuilds the file.

## Reading a mixed database

The `sage:v1:` prefix makes a half-encrypted file safe to read. A field with the prefix is decrypted, and a field without it is returned as it is. Entries written before encryption, or left over from an interrupted rewrite, read correctly.

A rewrite also checks every prefixed field. It encrypts any value that is not valid ciphertext, including plaintext that happens to start with `sage:v1:`.

## Searching encrypted entries

SQL cannot match text inside ciphertext, so search decrypts in memory instead. Journal search pages through every entry, decrypts each title and body, and matches there. Chat search does the same for chat titles and the user and assistant text in each event.

Both return newest first and stop at 25 results, and chat search keeps at most 3 message hits per conversation. Each search reads the whole journal and every saved transcript, which is fast enough at personal-journal sizes.

## Unlocking

Unlocking with a password happens in three steps in `handleLockUnlock` in `src/main.zig`:

1. Sage checks the password against the lock’s hash.
2. Sage derives the wrapping key and unwraps the data key into memory.
3. Only then does the lock open.

If the stored key material cannot be opened, Sage stays locked even with the right password, as [Recovery](recovery.md#the-stored-key-material-is-damaged) explains. Unlocking with Touch ID reads the same data key from the Keychain instead, as [The Touch ID Keychain mirror](keychain.md) explains.

## Unlocking with the recovery key

The lock screen shows **Use recovery key** when encryption is on and a recovery key exists. A wrong key counts like a wrong password, and the two share one count and one wait, as [The app lock](lock.md#wrong-guesses) explains. Text that is not 24 letters and numbers is treated as a typo and does not count.

After a right key, Sage:

1. Unwraps the data key from the recovery slot.
2. Sets `enc.recovery_rotate`, because you typed the key and it is no longer secret.
3. Puts the data key back in the Keychain if Touch ID is on. If that write fails, the journal still opens, and Sage warns that Touch ID will not work next time.
4. Opens the lock and asks you to make a new recovery key.

If you quit before you save a new key, Sage asks again on the next unlock.

For the rest of that session, four changes need no proof, because you may have forgotten your password: setting a password, removing the password, making a new recovery key, and removing encryption. Turning Touch ID off and turning the lock off still need the password or a fresh prompt. Locking the session or turning the lock off ends this session-only exception.

## Changing your password

Changing the password re-wraps the data key with the new password, in the same transaction that updates the hash. The two never point at different passwords, and no entry is rewritten, because the data key does not change.

That transaction also sets `enc.scrub_pending`, because the old wrapped key can still sit in free pages or in the write-ahead log. Sage then rebuilds the file the same way it does after turning encryption on.

A failed rebuild is not a failed change. The new password is already saved, so the command reports success, `enc.scrub_pending` stays set, and the securing screen retries through `encryption.scrub`.

With Touch ID alone, setting a first password adds a way to open the file without the Keychain, so it needs a fresh Touch ID prompt. Sage then adds the password slot and keeps the recovery slot.

## Removing your password

With Touch ID on, **Remove password** leaves Touch ID as the way in, and it needs your current password. With encryption on, Sage first makes a new recovery key and has you type it back, so you hold a working key when the password goes. The old recovery key stops working.

Sage checks the password and the new recovery key first, so a refused request changes nothing. Then one transaction deletes `lock.password_hash`, `enc.kdf`, and `enc.wrapped_key`, writes the new recovery slot, and sets `enc.scrub_pending`. Sage also stores the data key in the Keychain again, because that copy is now how you open the journal, and rebuilds the file to remove the old password wrap.

## Making a new recovery key

**Make a new recovery key** replaces the recovery slot, and the old key stops working. It needs your password, or a fresh Touch ID prompt when no password is set, and nothing right after an unlock with the recovery key. One transaction writes the new slot, clears `enc.recovery_rotate`, and sets `enc.scrub_pending`, so the rebuild removes the old wrap from the file.

## Turning encryption off

Turning encryption off decrypts every protected field before Sage removes the key:

1. Sage checks your password, or a fresh Touch ID prompt with no password, and marks the disable unfinished. Right after an unlock with the recovery key, it needs neither.
2. Sage decrypts each row while the data key is still in memory.
3. If every field decrypts, Sage deletes the setup rows, zeroes the key, and removes the Keychain copy.
4. Sage marks the file rebuild pending and rebuilds the database.
5. Sage deletes `.eve/.workflow-data` and starts Chat without a world key.

If Sage quits during the walk, the next unlock finishes the disable. A field that looks like ciphertext but fails its authentication tag keeps encryption on and keeps the key, and the securing screen reports the failure. If the rebuild fails, Sage keeps Chat stopped and retries the rebuild.

## Chat workflow files

A packaged app stores eve session state as files under `~/Library/Application Support/com.wasimxyz.sage/eve/.eve/.workflow-data`. The agent uses `@sage/world-encrypted-local`, a thin wrapper around Workflow’s local storage.

When encryption is on, Sage derives a separate 32-byte world key from the data key and passes it to the packaged Chat server:

- The key comes from HKDF-SHA256 with the label `sage/eve-world/v1`, a standard way to make a separate key from another key.
- Sage writes it only into the pipe the Chat server reads at start, never into the process environment.
- The Workflow runtime encrypts message and tool payloads with it before they reach disk. Run ids, event types, and timestamps stay readable.

`eve dev`, including `make dev`, never receives the world key, so files under `agent/.eve/` stay plaintext even when journal encryption is on.

Packaged Chat does not run while Sage is locked, with or without encryption. A session lock stops the packaged Chat server and clears the world key from the Node.js process. Turning encryption on or off deletes the session files, so plaintext and ciphertext never mix, but the SQLite chat transcripts stay.

eve also writes a `$eve.title` session attribute next to those files. That title is not a Workflow payload, so it stays plaintext even when encryption is on. Sage does not use it, because the Chat screen reads the encrypted `chat_conversation.title` from SQLite.

## What stays readable

These stay unencrypted on purpose, so the date-sorted sidebar, search by meaning, and chat resume stay fast:

- Dates and word counts
- Embedding and summary vectors
- Chat session ids, event positions, model names, Thinking settings, and context lengths

Someone holding the file can see when and how much you wrote, and can run searches against the vectors. They cannot read the words or the chat transcripts.

Export writes entries and chat transcripts as plaintext files in the folder you pick, even when encryption is on. Sage does not track or encrypt those files afterward, as [Chat storage](../agent/storage.md#exporting-conversations) explains.

## Scrubbing old bytes

Overwriting a SQLite row leaves the old bytes in free pages and in the write-ahead log until those pages are reused. After a rewrite, Sage checkpoints the log (`PRAGMA wal_checkpoint(TRUNCATE)`) and rebuilds the file (`VACUUM`), so those pages come back without the old plaintext. `enc.scrub_pending` tracks the rebuild, and once it succeeds, later launches do not rebuild the whole file again.

From then on, `PRAGMA secure_delete=ON` zeroes the bytes of deleted or overwritten rows as they go, even with encryption off. Deleting data from Settings also rebuilds the file after the rows are gone.

Recovery after a crash follows the pending rows:

- If `enc.disable_pending` is set, Sage waits for unlock, decrypts the remaining rows, and removes the setup rows only after the walk succeeds.
- If only `enc.rewrite_pending` is set, Sage encrypts the remaining rows instead.
- On launch with encryption on, Sage also checks protected fields for plaintext and marks a rewrite if it finds any.

Journal commands, export, and Chat wait until the rewrite and rebuild finish. A rebuild before unlock runs only when no row walk is pending.

Some old bytes are out of Sage’s reach. A copy of the file made before the rebuild can still hold old words, including an APFS snapshot or a Time Machine backup. So can leftover bytes on flash storage that spreads writes across the drive, but the live database file does not.
