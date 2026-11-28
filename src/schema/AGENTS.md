# Schema migrations

Files here are append-only. Installed journals may have applied every earlier migration, so never edit or delete one after it merges. Write a new migration instead.

## A migration ships as one set

- A new `NNNN_short_name.sql`, numbered after the last one.
- Its line in the `migrations` array in `src/journal.zig`.
- The `src/schema/migrations.lock.json` that the build writes. Commit it, and never edit it by hand. Errors NS1406 and NS1407 mean an accepted migration changed or went missing.
- A Zig test that upgrades a store from the version before (`upgradedStoreFrom`).
- The tables in `docs/agent/storage.md`, or the feature's docs page.

## Rules

- Migrate old rows forward. A change must not lose data people already have.
- A new column or table is either encrypted or listed under "What stays readable" in `docs/security/encryption.md`.
- Delete-all and bulk delete must clear every new table.
- Ids shown to the model or in tool cards are never reused. Entries and chats keep their own counters.
- An eve upgrade that changes the session format adds a migration that clears `eve_session_id`.
- A list limit in the store splits the work into batches instead of failing.

## The dev database

`error: SqliteVersionUnknown` means a newer branch has migrated the dev journal. Don't reset it. Run with a scratch `SAGE_DATA_DIR` instead.
