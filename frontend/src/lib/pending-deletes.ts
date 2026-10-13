// Deleting an entry or a chat is undoable for a few seconds. The row hides at
// once, and the real delete runs when the window to undo closes. This module
// holds the hidden rows. It knows nothing about the bridge or toasts, and it
// lives outside React, so it survives the app locking and unmounting.

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

/** Forget every waiting delete without running it, for a data wipe. */
export function discardAll(): void {
  pending.clear();
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
