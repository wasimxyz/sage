import assert from "node:assert/strict";
import test from "node:test";

import { type PollHost, startVisiblePoll } from "./visible-poll.ts";

interface FakePage extends PollHost {
  advance: (ms: number) => Promise<void>;
  now: () => number;
  setHidden: (hidden: boolean) => Promise<void>;
  timerCount: () => number;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakePage(hidden = false): FakePage {
  let now = 0;
  let nextId = 1;
  let isHidden = hidden;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  // Fires each timer due by `end`, in order, letting its check settle.
  const runDue = async (end: number): Promise<void> => {
    const [due] = [...timers.entries()]
      .filter(([, entry]) => entry.at <= end)
      .sort(([, a], [, b]) => a.at - b.at);
    if (!due) {
      now = end;
      return;
    }
    const [id, timer] = due;
    timers.delete(id);
    now = timer.at;
    timer.callback();
    await flush();
    await runDue(end);
  };
  return {
    advance: (ms) => runDue(now + ms),
    clearTimer: (id) => {
      timers.delete(id);
    },
    isHidden: () => isHidden,
    now: () => now,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHidden: async (value) => {
      isHidden = value;
      for (const listener of listeners) {
        listener();
      }
      await flush();
    },
    setTimer: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    timerCount: () => timers.size,
  };
}

function recorder(page: FakePage) {
  const starts: number[] = [];
  return {
    check: () => {
      starts.push(page.now());
      return Promise.resolve();
    },
    starts,
  };
}

test("startVisiblePoll checks at once, then each delay after a check", async () => {
  const page = fakePage();
  const { check, starts } = recorder(page);
  startVisiblePoll({ check, delayMs: 4000, host: page, leading: true });
  await flush();
  await page.advance(12_000);
  assert.deepEqual(starts, [0, 4000, 8000, 12_000]);
});

test("startVisiblePoll waits a full delay when leading is off", async () => {
  const page = fakePage();
  const { check, starts } = recorder(page);
  startVisiblePoll({ check, delayMs: 15_000, host: page, leading: false });
  await flush();
  await page.advance(15_000);
  assert.deepEqual(starts, [15_000]);
});

test("startVisiblePoll stops while hidden and checks once on return", async () => {
  const page = fakePage();
  const { check, starts } = recorder(page);
  startVisiblePoll({ check, delayMs: 4000, host: page, leading: true });
  await flush();
  await page.advance(500);
  await page.setHidden(true);
  assert.equal(page.timerCount(), 0);
  await page.advance(3400);
  await page.setHidden(false);
  // The return check restarts the delay, so 4000 brings no second check.
  await page.advance(3999);
  assert.deepEqual(starts, [0, 3900]);
  await page.advance(1);
  assert.deepEqual(starts, [0, 3900, 7900]);
});

test("startVisiblePoll runs one check at a time", async () => {
  const page = fakePage();
  const starts: number[] = [];
  const pending: (() => void)[] = [];
  const check = () => {
    starts.push(page.now());
    return new Promise<void>((resolve) => {
      pending.push(resolve);
    });
  };
  startVisiblePoll({ check, delayMs: 4000, host: page, leading: true });
  await flush();
  await page.advance(10_000);
  await page.setHidden(true);
  await page.setHidden(false);
  assert.deepEqual(starts, [0]);
  pending[0]?.();
  await flush();
  await page.advance(4000);
  assert.deepEqual(starts, [0, 14_000]);
});

test("startVisiblePoll keeps going after a failed check", async () => {
  const page = fakePage();
  const starts: number[] = [];
  const check = () => {
    starts.push(page.now());
    return Promise.reject(new Error("Ollama is not running."));
  };
  startVisiblePoll({ check, delayMs: 4000, host: page, leading: true });
  await flush();
  await page.advance(8000);
  assert.deepEqual(starts, [0, 4000, 8000]);
});

test("startVisiblePoll reads a delay function after each check", async () => {
  const page = fakePage();
  const { check, starts } = recorder(page);
  const delays = [250, 250, 4000];
  startVisiblePoll({
    check,
    delayMs: () => delays.shift() ?? 4000,
    host: page,
    leading: true,
  });
  await flush();
  await page.advance(4500);
  assert.deepEqual(starts, [0, 250, 500, 4500]);
});

test("startVisiblePoll in a hidden window checks only when it shows", async () => {
  const page = fakePage(true);
  const { check, starts } = recorder(page);
  startVisiblePoll({ check, delayMs: 4000, host: page, leading: true });
  await flush();
  await page.advance(20_000);
  assert.deepEqual(starts, [0]);
  await page.setHidden(false);
  assert.deepEqual(starts, [0, 20_000]);
});

test("startVisiblePoll stops for good", async () => {
  const page = fakePage();
  const starts: number[] = [];
  let finish: () => void = () => undefined;
  const check = () => {
    starts.push(page.now());
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const stop = startVisiblePoll({
    check,
    delayMs: 4000,
    host: page,
    leading: true,
  });
  await flush();
  stop();
  finish();
  await flush();
  await page.setHidden(true);
  await page.setHidden(false);
  await page.advance(20_000);
  assert.deepEqual(starts, [0]);
  assert.equal(page.timerCount(), 0);
});
