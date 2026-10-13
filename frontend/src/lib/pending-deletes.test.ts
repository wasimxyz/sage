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
  subscribe,
  undo,
} from "./pending-deletes.ts";

afterEach(() => {
  discardAll();
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
