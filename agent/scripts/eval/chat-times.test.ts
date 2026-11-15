// The time rewrite, against a temporary SQLite file built from the real
// migrations in src/schema/.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { localDayOf } from "../../agent/lib/when.ts";
import {
  assertThrowawayDatabase,
  chatTimestamp,
  rewriteChatTimes,
} from "./chat-times.ts";

const pattern4 = /not a real date|YYYY/u;
const pattern3 = /Refusing to rewrite/u;
const pattern2 = /Chat 99 is not in the database/u;
const pattern1 = /not a YYYY-MM-DD date/u;

const schemaDir = fileURLToPath(
  new URL("../../../src/schema", import.meta.url)
);

const NOW = "2026-11-11T09:30:00.000Z";

interface Rig {
  db: DatabaseSync;
  dbPath: string;
  dir: string;
}

/** A database with every migration applied, in a folder the guard accepts. */
function makeRig(t: test.TestContext, prefix = "sage-eval-chat-times-"): Rig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { force: true, recursive: true });
  });
  const dbPath = join(dir, "app.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  const files = readdirSync(schemaDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    db.exec(readFileSync(join(schemaDir, name), "utf8"));
  }
  return { db, dbPath, dir };
}

/** A chat the way Sage saves one: every time is the clock of the save. */
function insertChat(db: DatabaseSync, id: number, events: number): void {
  db.prepare(
    "INSERT INTO chat_conversation (id, title, events, created_at, updated_at) VALUES (?, ?, '', ?, ?)"
  ).run(id, `Chat ${id}`, NOW, NOW);
  for (let seq = 0; seq < events; seq += 1) {
    db.prepare(
      "INSERT INTO chat_event (conversation_id, seq, event, saved_at) VALUES (?, ?, ?, ?)"
    ).run(
      id,
      seq,
      `{"type":"message.received","data":{"message":"m${seq}"}}`,
      NOW
    );
  }
  db.prepare(
    "INSERT INTO chat_index_state (conversation_id, indexed_at) VALUES (?, ?)"
  ).run(id, "2026-11-11T09:31:00.000Z");
}

function row<T>(
  db: DatabaseSync,
  sql: string,
  ...values: (number | string)[]
): T {
  return db.prepare(sql).get(...values) as T;
}

test("chatTimestamp puts a chat at noon UTC on its day, and spreads events a minute apart", () => {
  assert.equal(chatTimestamp("2026-09-12"), "2026-09-12T12:00:00.000Z");
  assert.equal(chatTimestamp("2026-09-12", 3), "2026-09-12T12:03:00.000Z");
  // Far more events than minutes in the afternoon stay inside the same day.
  assert.equal(chatTimestamp("2026-09-12", 5000), "2026-09-12T23:59:00.000Z");
  assert.throws(() => chatTimestamp("12 Sept"), pattern1);
  assert.throws(() => chatTimestamp("2026-02-30"), pattern4);
});

test("a chat starts on its own day in the time zones from UTC-12 to UTC+11, and a day late from UTC+12", (t) => {
  const before = process.env.TZ;
  t.after(() => {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  });
  // search_chats shows a chat's day, and filters by `when`, in local days.
  // Etc/GMT+12 is UTC-12, and Etc/GMT-11 is UTC+11.
  for (const zone of [
    "Etc/GMT+12",
    "Pacific/Pago_Pago",
    "America/Los_Angeles",
    "UTC",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Etc/GMT-11",
  ]) {
    process.env.TZ = zone;
    for (const minutes of [0, 30]) {
      assert.equal(
        localDayOf(chatTimestamp("2026-09-12", minutes)),
        "2026-09-12",
        `${zone}, ${minutes} minutes in`
      );
    }
  }
  // Noon UTC is midnight at UTC+12, so the chat is a day late there.
  process.env.TZ = "Etc/GMT-12";
  assert.equal(localDayOf(chatTimestamp("2026-09-12")), "2026-09-13");
});

test("the guard accepts app.db in a sage-eval folder and refuses anything else", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sage-eval-guard-"));
  t.after(() => {
    rmSync(dir, { force: true, recursive: true });
  });
  assert.doesNotThrow(() => assertThrowawayDatabase(join(dir, "app.db")));
  for (const path of [
    "/Users/someone/Library/Application Support/com.wasimxyz.sage/app.db",
    join(tmpdir(), "elsewhere", "app.db"),
    join(dir, "other.db"),
    join(dir, "..", "app.db"),
  ]) {
    assert.throws(() => assertThrowawayDatabase(path), pattern3, path);
  }
});

test("a database outside a sage-eval folder is left alone", (t) => {
  const rig = makeRig(t, "journal-copy-");
  insertChat(rig.db, 1, 2);
  rig.db.close();
  assert.throws(
    () => rewriteChatTimes(rig.dbPath, [{ date: "2026-09-12", id: 1 }]),
    pattern3
  );
  const db = new DatabaseSync(rig.dbPath);
  assert.equal(
    row<{ created_at: string }>(
      db,
      "SELECT created_at FROM chat_conversation WHERE id = 1"
    ).created_at,
    NOW
  );
  db.close();
});

test("each seeded chat moves to its own day: created, updated, every event, and the index time", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 4);
  insertChat(rig.db, 2, 2);
  rig.db.close();

  const result = rewriteChatTimes(rig.dbPath, [
    { date: "2026-09-12", id: 1 },
    { date: "2026-04-08", id: 2 },
  ]);
  assert.deepEqual(result, { chats: 2, events: 6 });

  const db = new DatabaseSync(rig.dbPath);
  t.after(() => db.close());
  const first = row<{
    created_at: string;
    unstamped_until: string | null;
    updated_at: string;
  }>(
    db,
    "SELECT created_at, updated_at, unstamped_until FROM chat_conversation WHERE id = ?",
    1
  );
  assert.equal(first.created_at, "2026-09-12T12:00:00.000Z");
  assert.equal(first.updated_at, "2026-09-12T12:03:00.000Z");
  assert.equal(first.unstamped_until, null);
  const savedAt = db
    .prepare(
      "SELECT saved_at FROM chat_event WHERE conversation_id = ? ORDER BY seq"
    )
    .all(1)
    .map((entry) => (entry as { saved_at: string }).saved_at);
  assert.deepEqual(savedAt, [
    "2026-09-12T12:00:00.000Z",
    "2026-09-12T12:01:00.000Z",
    "2026-09-12T12:02:00.000Z",
    "2026-09-12T12:03:00.000Z",
  ]);
  const second = row<{ created_at: string; updated_at: string }>(
    db,
    "SELECT created_at, updated_at FROM chat_conversation WHERE id = ?",
    2
  );
  assert.equal(second.created_at, "2026-04-08T12:00:00.000Z");
  assert.equal(second.updated_at, "2026-04-08T12:01:00.000Z");
});

test("the index time stays later than the chat, so a rewritten chat is not due for indexing again", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 2);
  insertChat(rig.db, 2, 2);
  // A chat dated after the clock of the run: its index time has to catch up.
  rig.db.close();
  rewriteChatTimes(rig.dbPath, [
    { date: "2026-09-12", id: 1 },
    { date: "2026-11-14", id: 2 },
  ]);
  const db = new DatabaseSync(rig.dbPath);
  t.after(() => db.close());
  const due = db
    .prepare(
      "SELECT chat_conversation.id FROM chat_conversation LEFT JOIN chat_index_state ON chat_index_state.conversation_id = chat_conversation.id WHERE chat_index_state.indexed_at IS NULL OR chat_index_state.indexed_at < chat_conversation.updated_at"
    )
    .all();
  assert.deepEqual(due, []);
  // An index time that was already later is not moved back.
  assert.equal(
    row<{ indexed_at: string }>(
      db,
      "SELECT indexed_at FROM chat_index_state WHERE conversation_id = 1"
    ).indexed_at,
    "2026-11-11T09:31:00.000Z"
  );
});

test("a search by time reads the new times: the chat is active on its day and not on the day of the run", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 3);
  rig.db.close();
  rewriteChatTimes(rig.dbPath, [{ date: "2026-09-12", id: 1 }]);
  const db = new DatabaseSync(rig.dbPath);
  t.after(() => db.close());
  // The range test of `chatActiveInRangeSql` in src/journal.zig.
  const active = (from: string, to: string) =>
    db
      .prepare(
        "SELECT 1 AS hit FROM chat_event WHERE conversation_id = 1 AND saved_at >= ? AND saved_at < ?"
      )
      .all(from, to).length > 0;
  assert.equal(
    active("2026-09-12T00:00:00.000Z", "2026-09-13T00:00:00.000Z"),
    true
  );
  assert.equal(
    active("2026-11-11T00:00:00.000Z", "2026-11-12T00:00:00.000Z"),
    false
  );
  assert.equal(
    active("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    true
  );
});

test("a chat that was not seeded, and the journal, are not touched", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 2);
  insertChat(rig.db, 2, 2);
  rig.db
    .prepare(
      "INSERT INTO journal_entry (id, entry_date, title, body, word_count, updated_at) VALUES (900, '2026-10-01', 'T', 'B', 1, ?)"
    )
    .run(NOW);
  rig.db.close();
  rewriteChatTimes(rig.dbPath, [{ date: "2026-09-12", id: 1 }]);
  const db = new DatabaseSync(rig.dbPath);
  t.after(() => db.close());
  assert.equal(
    row<{ created_at: string }>(
      db,
      "SELECT created_at FROM chat_conversation WHERE id = 2"
    ).created_at,
    NOW
  );
  assert.equal(
    row<{ saved_at: string }>(
      db,
      "SELECT saved_at FROM chat_event WHERE conversation_id = 2 AND seq = 0"
    ).saved_at,
    NOW
  );
  assert.equal(
    row<{ updated_at: string }>(
      db,
      "SELECT updated_at FROM journal_entry WHERE id = 900"
    ).updated_at,
    NOW
  );
});

test("an unstamped_until that was set moves with the chat, and a missing chat undoes the whole rewrite", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 2);
  rig.db
    .prepare("UPDATE chat_conversation SET unstamped_until = ? WHERE id = 1")
    .run(NOW);
  rig.db.close();
  assert.throws(
    () =>
      rewriteChatTimes(rig.dbPath, [
        { date: "2026-09-12", id: 1 },
        { date: "2026-09-13", id: 99 },
      ]),
    pattern2
  );
  let db = new DatabaseSync(rig.dbPath);
  assert.equal(
    row<{ created_at: string }>(
      db,
      "SELECT created_at FROM chat_conversation WHERE id = 1"
    ).created_at,
    NOW,
    "chat 1 is back as it was"
  );
  db.close();

  rewriteChatTimes(rig.dbPath, [{ date: "2026-09-12", id: 1 }]);
  db = new DatabaseSync(rig.dbPath);
  t.after(() => db.close());
  assert.equal(
    row<{ unstamped_until: string }>(
      db,
      "SELECT unstamped_until FROM chat_conversation WHERE id = 1"
    ).unstamped_until,
    "2026-09-12T12:01:00.000Z"
  );
});

test("a bad date is refused before the database is opened", (t) => {
  const rig = makeRig(t);
  insertChat(rig.db, 1, 1);
  rig.db.close();
  assert.throws(
    () => rewriteChatTimes(rig.dbPath, [{ date: "last week", id: 1 }]),
    pattern1
  );
});
