import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultUnlockMethod,
  launchScreen,
  ollamaScreen,
  protectionBanner,
  protectionLine,
  protectScreen,
  type ReminderInput,
  reminderDue,
  remindersLeftLine,
  setupProtectScreen,
  touchIdChoiceAvailable,
  touchIdReady,
} from "./onboarding.ts";

const dayMs = 86_400_000;
const now = 1_800_000_000_000;

function due(overrides: Partial<ReminderInput>) {
  return reminderDue({
    encrypted: false,
    nowMs: now,
    ranSetupThisLaunch: false,
    reminderLastAtMs: 0,
    reminderShownThisLaunch: false,
    remindersOff: false,
    remindersShown: 0,
    state: "done",
    ...overrides,
  });
}

// --- the first screen ---

test("a new person starts setup at Welcome", () => {
  assert.deepEqual(launchScreen({ state: null, step: "welcome" }), {
    kind: "setup",
    step: "welcome",
  });
});

test("a person with no state starts at Welcome even if a step was saved", () => {
  assert.deepEqual(launchScreen({ state: null, step: "protect" }), {
    kind: "setup",
    step: "welcome",
  });
});

test("setup left half done opens where the person stopped", () => {
  for (const step of [
    "welcome",
    "local_ai",
    "protect",
    "import",
    "all_set",
  ] as const) {
    assert.deepEqual(launchScreen({ state: "active", step }), {
      kind: "setup",
      step,
    });
  }
});

test("done and skipped open Home", () => {
  assert.deepEqual(launchScreen({ state: "done", step: "all_set" }), {
    kind: "home",
  });
  assert.deepEqual(launchScreen({ state: "skipped", step: "local_ai" }), {
    kind: "home",
  });
});

// --- the Local AI screen ---

test("a running Ollama goes straight to the downloads", () => {
  assert.equal(ollamaScreen({ installed: true, running: true }), "downloads");
  // A running server is installed by definition, but the core says so too.
  assert.equal(ollamaScreen({ installed: false, running: true }), "downloads");
});

test("an installed Ollama that is not running gets a start first", () => {
  assert.equal(ollamaScreen({ installed: true, running: false }), "start");
});

test("a missing Ollama gets the install steps", () => {
  assert.equal(ollamaScreen({ installed: false, running: false }), "install");
});

// --- the Protect screen ---

test("with no lock the person chooses how to unlock", () => {
  assert.equal(protectScreen({ enabled: false, encrypted: false }), "choose");
});

test("with a lock and no encryption Sage goes straight to encryption", () => {
  assert.equal(protectScreen({ enabled: true, encrypted: false }), "encrypt");
});

test("with a lock and encryption there is nothing left to ask", () => {
  assert.equal(protectScreen({ enabled: true, encrypted: true }), "done");
});

test("setup does not ask again after the person chose no encryption", () => {
  const lockOn = { enabled: true, encrypted: false };
  assert.equal(
    setupProtectScreen(lockOn, { encrypt: false, method: "touch_id" }),
    "done"
  );
  // Nothing saved yet, so the missing choice is not a "no".
  assert.equal(
    setupProtectScreen(lockOn, { encrypt: false, method: null }),
    "encrypt"
  );
  assert.equal(
    setupProtectScreen(lockOn, { encrypt: true, method: "password" }),
    "encrypt"
  );
  assert.equal(
    setupProtectScreen(
      { enabled: false, encrypted: false },
      { encrypt: false, method: "password" }
    ),
    "choose"
  );
});

test("Touch ID starts picked only on a Mac with a fingerprint sensor", () => {
  assert.equal(defaultUnlockMethod({ touchIdHardware: true }), "touch_id");
  assert.equal(defaultUnlockMethod({ touchIdHardware: false }), "password");
  assert.equal(touchIdChoiceAvailable({ touchIdHardware: true }), true);
  assert.equal(touchIdChoiceAvailable({ touchIdHardware: false }), false);
});

test("a sensor that cannot be used right now still offers Touch ID", () => {
  // A MacBook with its lid closed over an external display reports biometrics
  // as unavailable, but it has the sensor and a Touch ID lock still works.
  const closedLid = { touchIdBiometrics: false, touchIdHardware: true };
  assert.equal(touchIdChoiceAvailable(closedLid), true);
  assert.equal(defaultUnlockMethod(closedLid), "touch_id");
  assert.equal(touchIdReady(closedLid), false);
  assert.equal(
    touchIdReady({ touchIdBiometrics: true, touchIdHardware: true }),
    true
  );
});

// --- the reminder schedule ---

test("no reminder before setup is over", () => {
  assert.equal(due({ state: null }), null);
  assert.equal(due({ state: "active" }), null);
});

test("the 1st reminder can show on any later launch", () => {
  assert.equal(due({ state: "done" }), 1);
  assert.equal(due({ state: "skipped" }), 1);
});

test("no reminder with encryption on, or after Don't ask again", () => {
  assert.equal(due({ encrypted: true }), null);
  assert.equal(due({ remindersOff: true }), null);
});

test("no reminder on the launch that ran setup", () => {
  assert.equal(due({ ranSetupThisLaunch: true }), null);
});

test("no second reminder in the same launch", () => {
  assert.equal(due({ reminderShownThisLaunch: true }), null);
});

test("the 2nd reminder waits 3 days after the 1st", () => {
  const shown = { remindersShown: 1 };
  assert.equal(due({ ...shown, reminderLastAtMs: now - 1 * dayMs }), null);
  assert.equal(
    due({ ...shown, reminderLastAtMs: now - (3 * dayMs - 1) }),
    null
  );
  assert.equal(due({ ...shown, reminderLastAtMs: now - 3 * dayMs }), 2);
  assert.equal(due({ ...shown, reminderLastAtMs: now - 30 * dayMs }), 2);
});

test("the 3rd reminder waits 7 days after the 2nd", () => {
  const shown = { remindersShown: 2 };
  assert.equal(due({ ...shown, reminderLastAtMs: now - 3 * dayMs }), null);
  assert.equal(
    due({ ...shown, reminderLastAtMs: now - (7 * dayMs - 1) }),
    null
  );
  assert.equal(due({ ...shown, reminderLastAtMs: now - 7 * dayMs }), 3);
});

test("no reminder after the 3rd", () => {
  assert.equal(
    due({ reminderLastAtMs: now - 365 * dayMs, remindersShown: 3 }),
    null
  );
  assert.equal(due({ remindersShown: 9 }), null);
});

test("a clock that moved back does not silence the reminders", () => {
  assert.equal(
    due({ reminderLastAtMs: now + 10 * dayMs, remindersShown: 1 }),
    2
  );
});

test("a reminder with no saved time is due", () => {
  assert.equal(due({ reminderLastAtMs: 0, remindersShown: 1 }), 2);
});

test("the line under the buttons counts what is left", () => {
  assert.equal(remindersLeftLine(1), "Sage will ask 2 more times.");
  assert.equal(remindersLeftLine(2), "Sage will ask 1 more time.");
});

// --- what was turned on ---

test("the Import banner names what is on, and says nothing when nothing is", () => {
  assert.equal(
    protectionBanner({ enabled: true, encrypted: true }),
    "Lock and encryption are on."
  );
  assert.equal(
    protectionBanner({ enabled: true, encrypted: false }),
    "Lock is on."
  );
  assert.equal(protectionBanner({ enabled: false, encrypted: false }), null);
});

test("the All set row reports the real lock state", () => {
  assert.deepEqual(protectionLine({ enabled: true, encrypted: true }), {
    on: true,
    text: "Lock and encryption are on",
  });
  assert.deepEqual(protectionLine({ enabled: true, encrypted: false }), {
    on: true,
    text: "Lock is on, encryption is off",
  });
  assert.deepEqual(protectionLine({ enabled: false, encrypted: false }), {
    on: false,
    text: "Lock and encryption are off",
  });
});
