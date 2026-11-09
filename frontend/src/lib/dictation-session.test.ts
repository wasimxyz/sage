import assert from "node:assert/strict";
import test from "node:test";

import {
  type DictationAction,
  type DictationSessionState,
  idleSession,
  isCurrentSession,
  isDictating,
  reduceDictation,
  speechModelPercent,
  startFailure,
  stopNotice,
  textVerdict,
} from "./dictation-session.ts";

function run(
  actions: DictationAction[],
  from: DictationSessionState = idleSession
): DictationSessionState {
  return actions.reduce(reduceDictation, from);
}

const listening = run([
  { owner: "entry", type: "requested" },
  { session: 7, type: "accepted" },
  { session: 7, type: "started" },
]);

test("a request starts a session that waits for the core", () => {
  const state = run([{ owner: "chat", type: "requested" }]);
  assert.equal(state.phase, "starting");
  assert.equal(state.owner, "chat");
  assert.equal(state.session, null);
  assert.equal(isDictating(state), true);
});

test("the core's id and its started message turn Starting into Listening", () => {
  const accepted = run([
    { owner: "entry", type: "requested" },
    { session: 7, type: "accepted" },
  ]);
  assert.equal(accepted.phase, "starting");
  assert.equal(accepted.session, 7);
  assert.equal(listening.phase, "listening");
  assert.equal(listening.owner, "entry");
});

test("a request while a session runs changes nothing", () => {
  assert.equal(
    reduceDictation(listening, { owner: "chat", type: "requested" }),
    listening
  );
});

test("a failed start goes back to idle", () => {
  const state = run([
    { owner: "entry", type: "requested" },
    { type: "failed" },
  ]);
  assert.deepEqual(state, idleSession);
});

test("a failure after the core answered does not end the session", () => {
  assert.equal(reduceDictation(listening, { type: "failed" }), listening);
});

test("started for another session is ignored", () => {
  const accepted = run([
    { owner: "entry", type: "requested" },
    { session: 7, type: "accepted" },
  ]);
  assert.equal(
    reduceDictation(accepted, { session: 6, type: "started" }),
    accepted
  );
});

test("text in order moves seq forward", () => {
  const state = run(
    [
      { seq: 1, session: 7, type: "text" },
      { seq: 2, session: 7, type: "text" },
    ],
    listening
  );
  assert.equal(state.lastSeq, 2);
  assert.equal(state.lostWords, false);
});

test("text for another session is ignored", () => {
  const state = reduceDictation(listening, {
    seq: 1,
    session: 6,
    type: "text",
  });
  assert.equal(state, listening);
  assert.equal(textVerdict(listening, 6, 1), "ignore");
});

test("text after the session ended is ignored", () => {
  const ended = reduceDictation(listening, { session: 7, type: "stopped" });
  assert.equal(textVerdict(ended, 7, 1), "ignore");
  assert.equal(
    reduceDictation(ended, { seq: 1, session: 7, type: "text" }),
    ended
  );
});

test("a seq that is not past the last one is ignored", () => {
  const state = run([{ seq: 3, session: 7, type: "text" }], listening);
  assert.equal(textVerdict(state, 7, 3), "ignore");
  assert.equal(textVerdict(state, 7, 2), "ignore");
  assert.equal(
    reduceDictation(state, { seq: 2, session: 7, type: "text" }),
    state
  );
});

test("a gap in seq is noticed", () => {
  assert.equal(textVerdict(listening, 7, 1), "ok");
  assert.equal(textVerdict(listening, 7, 3), "gap");
  const state = run([{ seq: 3, session: 7, type: "text" }], listening);
  assert.equal(state.lostWords, true);
  assert.equal(state.lastSeq, 3);
});

test("a gap is noticed once, so the page can say so once", () => {
  const states = [listening];
  for (const seq of [1, 3, 4, 8]) {
    const last = states.at(-1) ?? listening;
    states.push(reduceDictation(last, { seq, session: 7, type: "text" }));
  }
  // The page shows its notice when the flag goes from false to true.
  const flips = states.filter(
    (state, index) =>
      index > 0 && state.lostWords && !states[index - 1].lostWords
  );
  assert.equal(flips.length, 1);
  assert.equal(states.at(-1)?.lostWords, true);
});

test("text before started still turns Starting into Listening", () => {
  const accepted = run([
    { owner: "entry", type: "requested" },
    { session: 7, type: "accepted" },
  ]);
  const state = reduceDictation(accepted, {
    seq: 1,
    session: 7,
    type: "text",
  });
  assert.equal(state.phase, "listening");
});

test("stop moves a running session to Finishing", () => {
  const state = reduceDictation(listening, { type: "stop" });
  assert.equal(state.phase, "finishing");
  assert.equal(isDictating(state), false);
  assert.equal(isCurrentSession(state, 7), true);
});

test("text still counts while Finishing", () => {
  const finishing = reduceDictation(listening, { type: "stop" });
  assert.equal(textVerdict(finishing, 7, 1), "ok");
});

test("stop before the core has answered waits for its id", () => {
  const starting = run([{ owner: "entry", type: "requested" }]);
  assert.equal(reduceDictation(starting, { type: "stop" }), starting);
});

test("stopped for the session ends it", () => {
  const state = reduceDictation(listening, { session: 7, type: "stopped" });
  assert.deepEqual(state, idleSession);
});

test("stopped for another session changes nothing", () => {
  assert.equal(
    reduceDictation(listening, { session: 6, type: "stopped" }),
    listening
  );
});

test("leaving ends a session at once, whatever its phase", () => {
  assert.deepEqual(reduceDictation(listening, { type: "left" }), idleSession);
  const starting = run([{ owner: "chat", type: "requested" }]);
  assert.deepEqual(reduceDictation(starting, { type: "left" }), idleSession);
  assert.equal(reduceDictation(idleSession, { type: "left" }), idleSession);
});

test("a new session starts with seq and the gap flag cleared", () => {
  const gapped = run([{ seq: 5, session: 7, type: "text" }], listening);
  const next = run(
    [
      { type: "left" },
      { owner: "entry", type: "requested" },
      { session: 8, type: "accepted" },
    ],
    gapped
  );
  assert.equal(next.lastSeq, 0);
  assert.equal(next.lostWords, false);
  assert.equal(next.session, 8);
});

test("stopNotice says nothing for a stop the person asked for", () => {
  for (const reason of ["user", "discarded", "locked", "quit"] as const) {
    assert.equal(stopNotice(reason, null), null);
  }
});

test("stopNotice points to System Settings when the mic is denied", () => {
  assert.deepEqual(stopNotice("denied", null), { kind: "denied" });
});

test("stopNotice shows the core's message for a failure", () => {
  assert.deepEqual(stopNotice("engine_failed", "Speech stopped."), {
    kind: "error",
    message: "Speech stopped.",
  });
});

test("stopNotice has its own words when the core sent none", () => {
  assert.deepEqual(stopNotice("no_input", null), {
    kind: "error",
    message: "Sage can't find a microphone.",
  });
  assert.deepEqual(stopNotice("input_lost", ""), {
    kind: "error",
    message: "The microphone stopped working.",
  });
});

test("startFailure names the core's errors", () => {
  assert.equal(startFailure("MicrophoneDenied"), "denied");
  assert.equal(startFailure("SpeechModelMissing"), "download");
  assert.equal(startFailure("SpeechModelChecking"), "checking");
  assert.equal(startFailure("DictationBusy"), "busy");
  assert.equal(startFailure("DictationUnavailable"), "unavailable");
  assert.equal(startFailure("Locked"), "locked");
  assert.equal(startFailure("Securing"), "locked");
  assert.equal(startFailure("OutOfMemory"), "other");
  assert.equal(startFailure(null), "other");
});

test("speechModelPercent rounds and clamps", () => {
  assert.equal(speechModelPercent(0.426), "43%");
  assert.equal(speechModelPercent(0), "0%");
  assert.equal(speechModelPercent(1.4), "100%");
  assert.equal(speechModelPercent(-1), "0%");
  assert.equal(speechModelPercent(null), null);
  assert.equal(speechModelPercent(Number.NaN), null);
});
