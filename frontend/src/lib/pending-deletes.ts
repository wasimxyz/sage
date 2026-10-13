// Deleting an entry or a chat is undoable for a few seconds. The row hides at
// once, and the real delete runs when the window to undo closes. This module
// holds the hidden rows. It knows nothing about the bridge or toasts, and it
// lives outside React, so it survives the app locking and unmounting.
//
// Waiting deletes are also kept in local storage. If Sage quits while it is
// locked, the delete cannot run, so the next launch runs it after the unlock.

export type DeleteKind = "chat" | "entry";

/**
 * What a commit reports. `retry` keeps the row hidden for a later attempt,
 * such as after the app unlocks. `failed` brings the row back.
 */
export type CommitResult = "done" | "failed" | "retry";

type Commit = () => Promise<CommitResult>;

interface Pending {
  commit: Commit;
  id: number;
  kind: DeleteKind;
  running: boolean;
}

interface Stored {
  id: number;
  kind: DeleteKind;
}

const storageKey = "sage-pending-deletes:v1";
const none: ReadonlySet<number> = new Set();
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
const committedListeners = new Set<(kind: DeleteKind, id: number) => void>();
let snapshots: Record<DeleteKind, ReadonlySet<number>> = {
  chat: none,
  entry: none,
};
let counter = 0;
let watchingPageHide = false;
// Deletes found in storage that no provider has taken back yet. Writing the
// current ones must not drop these.
let carried: Stored[] | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, kind } = value as { id?: unknown; kind?: unknown };
  return (
    (kind === "chat" || kind === "entry") &&
    typeof id === "number" &&
    Number.isInteger(id)
  );
}

function readStored(): Stored[] {
  try {
    const raw = storage()?.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStored) : [];
  } catch {
    return [];
  }
}

function loadCarried(): Stored[] {
  carried ??= readStored();
  return carried;
}

function writeStored() {
  const items: Stored[] = [
    ...[...pending.values()].map(({ id, kind }) => ({ id, kind })),
    ...loadCarried(),
  ];
  try {
    const store = storage();
    if (items.length === 0) {
      store?.removeItem(storageKey);
    } else {
      store?.setItem(storageKey, JSON.stringify(items));
    }
  } catch {
    // A full or blocked store only means a delete will not survive a quit.
  }
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

// Subscribers compare snapshots by identity, so a kind whose rows did not
// change keeps the set it had.
function emit() {
  const next: Record<DeleteKind, Set<number>> = {
    chat: new Set(),
    entry: new Set(),
  };
  for (const item of pending.values()) {
    next[item.kind].add(item.id);
  }
  snapshots = {
    chat: sameSet(snapshots.chat, next.chat) ? snapshots.chat : next.chat,
    entry: sameSet(snapshots.entry, next.entry) ? snapshots.entry : next.entry,
  };
  writeStored();
  for (const listener of listeners) {
    listener();
  }
}

function watchPageHide() {
  if (watchingPageHide || typeof window === "undefined") {
    return;
  }
  watchingPageHide = true;
  // Closing the window runs every delete that is still waiting.
  window.addEventListener("pagehide", () => {
    commitAll().catch(() => undefined);
  });
}

/** Hide a row and return the key that undoes or commits it. */
export function hide(kind: DeleteKind, id: number, run: Commit): string {
  counter += 1;
  const key = `${kind}:${id}:${counter}`;
  pending.set(key, { commit: run, id, kind, running: false });
  watchPageHide();
  emit();
  return key;
}

/** Show the row again. False when the delete has already started. */
export function undo(key: string): boolean {
  const item = pending.get(key);
  if (!item || item.running) {
    return false;
  }
  pending.delete(key);
  emit();
  return true;
}

/** Run the delete. Does nothing for a key that was undone or already ran. */
export async function commit(key: string): Promise<void> {
  const item = pending.get(key);
  if (!item || item.running) {
    return;
  }
  item.running = true;
  let result: CommitResult;
  try {
    result = await item.commit();
  } catch {
    result = "failed";
  }
  item.running = false;
  if (result === "retry") {
    return;
  }
  pending.delete(key);
  if (result === "done") {
    // Listeners drop their copy of the row before the hidden set empties, so
    // the row never flashes back.
    for (const listener of committedListeners) {
      listener(item.kind, item.id);
    }
  }
  emit();
}

/** Run every waiting delete, or only those of one kind. */
export async function commitAll(kind?: DeleteKind): Promise<void> {
  const keys = [...pending]
    .filter(([, item]) => kind === undefined || item.kind === kind)
    .map(([key]) => key);
  await Promise.all(keys.map((key) => commit(key)));
}

/**
 * Forget every waiting delete without running it, including those saved from
 * an earlier launch. After a data wipe their ids could belong to new rows.
 */
export function discardAll(): void {
  pending.clear();
  carried = [];
  emit();
  carried = null;
}

/**
 * Take back the deletes of one kind that were waiting when Sage last ran, and
 * hide those rows again. The caller supplies the real delete, because that
 * lives in a provider. Run `commitAll` for the kind afterward.
 */
export function restore(
  kind: DeleteKind,
  run: (id: number) => Promise<CommitResult>
): void {
  const stored = loadCarried();
  const mine = stored.filter((item) => item.kind === kind);
  carried = stored.filter((item) => item.kind !== kind);
  for (const { id } of mine) {
    if (!isHidden(kind, id)) {
      hide(kind, id, () => run(id));
    }
  }
  emit();
}

/** The ids of rows that are hidden. The same set until something changes. */
export function hiddenIds(kind: DeleteKind): ReadonlySet<number> {
  return snapshots[kind];
}

export function isHidden(kind: DeleteKind, id: number): boolean {
  return snapshots[kind].has(id);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called after a delete succeeds, so a list can drop its copy of the row. */
export function onCommitted(
  listener: (kind: DeleteKind, id: number) => void
): () => void {
  committedListeners.add(listener);
  return () => {
    committedListeners.delete(listener);
  };
}
