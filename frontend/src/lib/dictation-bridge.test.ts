import assert from "node:assert/strict";
import test from "node:test";

import {
  dictationErrorCode,
  getDictationStatus,
  onDictationStarted,
  onDictationStopped,
  onDictationText,
} from "../bridge.ts";

type Handler = (detail: unknown) => void;

// The bridge reads `window.zero` when a listener is added or a command runs.
// Hand it one that keeps the handlers, so a test can send an event the way the
// core does, and that answers `invoke` from `answer`.
const handlers = new Map<string, Handler>();
let answer: unknown = null;
Object.assign(globalThis, {
  window: {
    zero: {
      invoke: () => Promise.resolve(answer),
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
    },
  },
});

function send(name: string, detail: unknown) {
  const handler = handlers.get(name);
  assert.ok(handler, `no listener for ${name}`);
  handler(detail);
}

test("a dictation event reaches its callback as parsed", () => {
  const seen: unknown[] = [];
  onDictationStarted((payload) => seen.push(payload));
  onDictationText((payload) => seen.push(payload));
  onDictationStopped((payload) => seen.push(payload));
  send("dictation:started", { session: 3 });
  send("dictation:text", { final: "hi", seq: 1, session: 3, volatile: "th" });
  send("dictation:stopped", { message: null, reason: "user", session: 3 });
  assert.deepEqual(seen, [
    { session: 3 },
    { final: "hi", seq: 1, session: 3, volatile: "th" },
    { message: null, reason: "user", session: 3 },
  ]);
});

test("a malformed dictation event is ignored", () => {
  let calls = 0;
  onDictationStarted(() => {
    calls += 1;
  });
  onDictationText(() => {
    calls += 1;
  });
  onDictationStopped(() => {
    calls += 1;
  });
  send("dictation:started", "nope");
  send("dictation:text", [1, 2]);
  send("dictation:stopped", null);
  assert.equal(calls, 0);
});

test("an error in the callback is not taken for a malformed event", () => {
  const boom = new Error("consumer failed");
  onDictationStarted(() => {
    throw boom;
  });
  onDictationText(() => {
    throw boom;
  });
  onDictationStopped(() => {
    throw boom;
  });
  assert.throws(() => send("dictation:started", { session: 1 }), boom);
  assert.throws(
    () =>
      send("dictation:text", { final: "", seq: 1, session: 1, volatile: "" }),
    boom
  );
  assert.throws(
    () =>
      send("dictation:stopped", { message: null, reason: "user", session: 1 }),
    boom
  );
});

test("an unknown stop reason still ends the session", () => {
  const seen: unknown[] = [];
  onDictationStopped((payload) => seen.push(payload));
  send("dictation:stopped", {
    message: null,
    reason: "from_the_future",
    session: 2,
  });
  assert.deepEqual(seen, [
    { message: null, reason: "engine_failed", session: 2 },
  ]);
});

const statusBase = {
  available: true,
  microphone: "granted",
  model: { fraction: null, message: null, state: "installed" },
  reason: null,
  session: null,
};

test("a status that is still checking the speech model parses", async () => {
  answer = { ...statusBase, model: { ...statusBase.model, state: "checking" } };
  const status = await getDictationStatus();
  assert.equal(status.model.state, "checking");
  assert.equal(status.available, true);
});

test("a Mac with no English speech model parses as no_english", async () => {
  answer = { ...statusBase, available: false, reason: "no_english" };
  const status = await getDictationStatus();
  assert.equal(status.available, false);
  assert.equal(status.reason, "no_english");
});

test("a status with a reason or model state it does not know is refused", async () => {
  answer = { ...statusBase, available: false, reason: "from_the_future" };
  await assert.rejects(getDictationStatus());
  answer = { ...statusBase, model: { ...statusBase.model, state: "later" } };
  await assert.rejects(getDictationStatus());
});

test("the core's checking error is a dictation error code", () => {
  const error = new Error("SpeechModelChecking: x", {
    cause: Object.assign(new Error("x"), { code: "SpeechModelChecking" }),
  });
  assert.equal(dictationErrorCode(error), "SpeechModelChecking");
});
