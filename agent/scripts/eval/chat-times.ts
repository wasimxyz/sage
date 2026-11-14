// Moves seeded past chats back to their own dates.
//
// Sage stamps a chat with the real clock when it saves one. A past chat of
// 2026-09-12 would look as if it were saved on the day of the run, so a search
// by time ("last month", "in September") would never find it, and Dream would
// give the chat that day's date. The runner stops Sage after the seed step has
// saved and indexed the chats, calls `rewriteChatTimes`, and starts Sage
// again. Only Sage's throwaway database is touched, and never while Sage runs,
// because only Sage's event-loop thread may write to its database.
//
// What a search or listing by time reads, per `docs/agent/storage.md`:
//
//   chat_event.saved_at              when a save added the event
//   chat_conversation.created_at     where a chat starts, and the date Dream gives it
//   chat_conversation.updated_at     where a chat ends
//   chat_conversation.unstamped_until  the stand-in for events with no saved_at
//
// Each chat gets a day, and its events are spread over that day, one minute
// apart from noon UTC, so their order holds and the day is the same in every
// time zone. `chat_index_state.indexed_at` is raised to the chat's last time
// when it is earlier, so a chat dated after the clock of the run is not due
// for indexing again.

import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

const THROWAWAY_PREFIX = "sage-eval-";
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const MS_PER_MINUTE = 60_000;
/** Noon to the last minute of the day. Events past this share the last minute. */
const LAST_MINUTE_OFFSET = 11 * 60 + 59;

/** One seeded chat and the day it belongs on. */
export interface ChatDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Sage's id for the chat, from the seed step's manifest. */
  id: number;
}

export interface RewriteResult {
  chats: number;
  events: number;
}

/** `YYYY-MM-DDTHH:MM:SS.000Z` for a chat's day, `minutes` after noon UTC. */
export function chatTimestamp(date: string, minutes = 0): string {
  if (!dayPattern.test(date)) {
    throw new Error(`"${date}" is not a YYYY-MM-DD date.`);
  }
  const noon = Date.parse(`${date}T12:00:00.000Z`);
  if (Number.isNaN(noon) || !new Date(noon).toISOString().startsWith(date)) {
    throw new Error(`"${date}" is not a real date.`);
  }
  const offset = Math.min(Math.max(minutes, 0), LAST_MINUTE_OFFSET);
  return new Date(noon + offset * MS_PER_MINUTE).toISOString();
}

/**
 * Refuses a database that is not an eval's throwaway copy. The runner makes
 * each data directory with the `sage-eval-` prefix, so this stops a path to the
 * real journal from ever being rewritten.
 */
export function assertThrowawayDatabase(dbPath: string): void {
  const path = resolve(dbPath);
  const folder = basename(dirname(path));
  if (basename(path) !== "app.db" || !folder.startsWith(THROWAWAY_PREFIX)) {
    throw new Error(
      `Refusing to rewrite chat times in ${path}: it is not app.db in a ${THROWAWAY_PREFIX}* folder, so it may not be a throwaway eval database.`
    );
  }
}

interface Statement {
  all: (...values: unknown[]) => unknown[];
  run: (...values: unknown[]) => unknown;
}

interface Database {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
}

function openDatabase(path: string): Database {
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite"
  ) as typeof import("node:sqlite");
  return new DatabaseSync(path) as unknown as Database;
}

function rewriteOne(db: Database, chat: ChatDay): number {
  const seqs = db
    .prepare(
      "SELECT seq FROM chat_event WHERE conversation_id = ? ORDER BY seq"
    )
    .all(chat.id) as { seq: number | bigint }[];
  const exists = db
    .prepare("SELECT id FROM chat_conversation WHERE id = ?")
    .all(chat.id);
  if (exists.length === 0) {
    throw new Error(`Chat ${chat.id} is not in the database.`);
  }
  const setEvent = db.prepare(
    "UPDATE chat_event SET saved_at = ? WHERE conversation_id = ? AND seq = ?"
  );
  for (const [position, row] of seqs.entries()) {
    setEvent.run(chatTimestamp(chat.date, position), chat.id, Number(row.seq));
  }
  const first = chatTimestamp(chat.date, 0);
  const last = chatTimestamp(chat.date, Math.max(seqs.length - 1, 0));
  db.prepare(
    "UPDATE chat_conversation SET created_at = ?, updated_at = ?, unstamped_until = CASE WHEN unstamped_until IS NULL THEN NULL ELSE ? END WHERE id = ?"
  ).run(first, last, last, chat.id);
  db.prepare(
    "UPDATE chat_index_state SET indexed_at = ? WHERE conversation_id = ? AND indexed_at < ?"
  ).run(last, chat.id, last);
  return seqs.length;
}

/**
 * Rewrites the times of the given chats to their days. Run it with Sage
 * stopped. It changes nothing but those chats, and either all of them change or
 * none do. A chat that is not in the database is an error.
 */
export function rewriteChatTimes(
  dbPath: string,
  chats: readonly ChatDay[]
): RewriteResult {
  assertThrowawayDatabase(dbPath);
  for (const chat of chats) {
    chatTimestamp(chat.date);
  }
  const db = openDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    let events = 0;
    try {
      for (const chat of chats) {
        events += rewriteOne(db, chat);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Fold the write-ahead log into the file, so a copy of app.db alone has it.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { chats: chats.length, events };
  } finally {
    db.close();
  }
}
