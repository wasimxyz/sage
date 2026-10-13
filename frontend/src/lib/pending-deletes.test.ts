import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  type CommitResult,
  commit,
  commitAll,
  discardAll,
  hiddenIds,
  hide,
  isHidden,
  onCommitted,
  restore,
  subscribe,
  undo,
} from "./pending-deletes.ts";

const storageKey = "sage-pending-deletes:v1";

// Node has no localStorage. This stands in for it, and a test can read it.
const fakeStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => fakeStorage.get(key) ?? null,
    removeItem: (key: string) => {
      fakeStorage.delete(key);
    },
    setItem: (key: string, value: string) => {
      fakeStorage.set(key, value);
    },
  },
});

// Pretend the last launch left these deletes waiting. Forgetting what earlier
// tests did makes the module read the store afresh.
function seedStorage(items: unknown) {
  discardAll();
  fakeStorage.set(
    storageKey,
    typeof items === "string" ? items : JSON.stringify(items)
  );
}

function stored(): unknown {
  const raw = fakeStorage.get(storageKey);
  return raw === undefined ? null : JSON.parse(raw);
}

afterEach(() => {
  discardAll();
  fakeStorage.clear();
});

function runner(...results: CommitResult[]) {
  const calls = { count: 0 };
  const run = (): Promise<CommitResult> => {
    calls.count += 1;
    const result = results[Math.min(calls.count - 1, results.length - 1)];
    return Promise.resolve(result ?? "done");
  };
  return { calls, run };
}

test("hiding a row puts its id in the hidden set for its kind only", () => {
  hide("entry", 4, runner("done").run);
  assert.equal(isHidden("entry", 4), true);
  assert.equal(isHidden("chat", 4), false);
  assert.deepEqual([...hiddenIds("entry")], [4]);
});

test("undo shows the row again and the delete never runs", async () => {
  const { calls, run } = runner("done");
  const key = hide("entry", 4, run);
  assert.equal(undo(key), true);
  assert.equal(isHidden("entry", 4), false);
  await commit(key);
  assert.equal(calls.count, 0);
});

test("a finished delete tells listeners before the row leaves the hidden set", async () => {
  const seen: string[] = [];
  const stop = onCommitted((kind, id) => {
    seen.push(`${kind}:${id}:hiddenWhenTold=${isHidden(kind, id)}`);
  });
  const key = hide("chat", 9, runner("done").run);
  await commit(key);
  stop();
  assert.deepEqual(seen, ["chat:9:hiddenWhenTold=true"]);
  assert.equal(isHidden("chat", 9), false);
});

test("a failed delete brings the row back and tells no one it is gone", async () => {
  const seen: number[] = [];
  const stop = onCommitted((_kind, id) => {
    seen.push(id);
  });
  const key = hide("entry", 2, runner("failed").run);
  await commit(key);
  stop();
  assert.deepEqual(seen, []);
  assert.equal(isHidden("entry", 2), false);
});

test("a commit that throws counts as failed", async () => {
  const key = hide("entry", 2, () => Promise.reject(new Error("boom")));
  await commit(key);
  assert.equal(isHidden("entry", 2), false);
});

test("a retry keeps the row hidden until a later attempt succeeds", async () => {
  const { calls, run } = runner("retry", "done");
  const key = hide("entry", 7, run);
  await commit(key);
  assert.equal(isHidden("entry", 7), true);
  await commitAll();
  assert.equal(calls.count, 2);
  assert.equal(isHidden("entry", 7), false);
});

test("a delete that is running cannot be undone or run twice", async () => {
  let release: (result: CommitResult) => void = () => undefined;
  const calls = { count: 0 };
  const key = hide("entry", 3, () => {
    calls.count += 1;
    return new Promise<CommitResult>((resolve) => {
      release = resolve;
    });
  });
  const first = commit(key);
  assert.equal(undo(key), false);
  await commit(key);
  assert.equal(calls.count, 1);
  release("done");
  await first;
  assert.equal(isHidden("entry", 3), false);
});

test("commitAll can limit itself to one kind", async () => {
  const entry = runner("done");
  const chat = runner("done");
  hide("entry", 1, entry.run);
  hide("chat", 1, chat.run);
  await commitAll("entry");
  assert.equal(entry.calls.count, 1);
  assert.equal(chat.calls.count, 0);
  assert.equal(isHidden("chat", 1), true);
});

test("two deletes of the same row hide it until both are settled", () => {
  const a = hide("entry", 5, runner("done").run);
  const b = hide("entry", 5, runner("done").run);
  undo(a);
  assert.equal(isHidden("entry", 5), true);
  undo(b);
  assert.equal(isHidden("entry", 5), false);
});

test("discardAll forgets deletes without running them", async () => {
  const { calls, run } = runner("done");
  hide("entry", 1, run);
  discardAll();
  await commitAll();
  assert.equal(calls.count, 0);
  assert.equal(isHidden("entry", 1), false);
});

test("a kind that did not change keeps the same set, so subscribers skip a render", () => {
  hide("entry", 1, runner("done").run);
  const before = hiddenIds("chat");
  hide("entry", 2, runner("done").run);
  assert.equal(hiddenIds("chat"), before);
  const entries = hiddenIds("entry");
  assert.equal(hiddenIds("entry"), entries);
});

test("subscribers are told on every change and can stop listening", () => {
  let told = 0;
  const stop = subscribe(() => {
    told += 1;
  });
  const key = hide("entry", 1, runner("done").run);
  undo(key);
  stop();
  hide("entry", 2, runner("done").run);
  assert.equal(told, 2);
});

test("waiting deletes are saved, and undo or a finished delete clears them", async () => {
  const keep = hide("entry", 1, runner("done").run);
  hide("chat", 2, runner("done").run);
  assert.deepEqual(stored(), [
    { id: 1, kind: "entry" },
    { id: 2, kind: "chat" },
  ]);
  undo(keep);
  assert.deepEqual(stored(), [{ id: 2, kind: "chat" }]);
  await commitAll();
  assert.equal(stored(), null);
});

test("a delete that must retry stays saved", async () => {
  hide("entry", 7, runner("retry").run);
  await commitAll();
  assert.deepEqual(stored(), [{ id: 7, kind: "entry" }]);
});

test("restore hides rows saved by an earlier launch and runs their delete", async () => {
  seedStorage([{ id: 5, kind: "entry" }]);
  const ran: number[] = [];
  restore("entry", (id) => {
    ran.push(id);
    return Promise.resolve("done");
  });
  assert.equal(isHidden("entry", 5), true);
  await commitAll("entry");
  assert.deepEqual(ran, [5]);
  assert.equal(isHidden("entry", 5), false);
  assert.equal(stored(), null);
});

test("restoring one kind keeps the other kind's saved deletes", () => {
  seedStorage([
    { id: 5, kind: "entry" },
    { id: 8, kind: "chat" },
  ]);
  restore("entry", () => Promise.resolve("done"));
  assert.deepEqual(stored(), [
    { id: 5, kind: "entry" },
    { id: 8, kind: "chat" },
  ]);
  restore("chat", () => Promise.resolve("done"));
  assert.equal(isHidden("chat", 8), true);
});

test("restore ignores a row that is already waiting and unreadable storage", () => {
  const key = hide("entry", 5, runner("done").run);
  restore("entry", () => Promise.resolve("done"));
  assert.equal(undo(key), true);
  assert.equal(isHidden("entry", 5), false);
  seedStorage("not json");
  restore("entry", () => Promise.resolve("done"));
  assert.equal(isHidden("entry", 5), false);
});

test("discardAll also forgets saved deletes", () => {
  hide("entry", 1, runner("done").run);
  discardAll();
  assert.equal(stored(), null);
});
