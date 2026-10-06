import assert from "node:assert/strict";
import test from "node:test";

import type { LockStatus } from "../bridge.ts";
import {
  claimLaunchTouchIdPrompt,
  type LaunchTouchIdPromptState,
} from "./launch-touch-id.ts";

function makeStatus(overrides: Partial<LockStatus> = {}): LockStatus {
  return {
    enabled: true,
    encrypted: false,
    idleTimeoutMs: 300_000,
    passwordSet: true,
    scrubbing: false,
    securing: false,
    touchIdAvailable: true,
    touchIdBiometrics: true,
    touchIdEnabled: true,
    touchIdHardware: true,
    unlocked: false,
    waitRemainingMs: 0,
    ...overrides,
  };
}

function makePromptState(): LaunchTouchIdPromptState {
  return { checked: false, eligible: false, prompted: false };
}

test("claims the initial locked Touch ID prompt once", () => {
  const state = makePromptState();
  const status = makeStatus();

  assert.equal(claimLaunchTouchIdPrompt(state, status), true);
  assert.equal(claimLaunchTouchIdPrompt(state, status), false);
});

test("does not auto-prompt after startup unlocked and a later relock", () => {
  const state = makePromptState();

  assert.equal(
    claimLaunchTouchIdPrompt(state, makeStatus({ unlocked: true })),
    false
  );
  assert.equal(claimLaunchTouchIdPrompt(state, makeStatus()), false);
});

test("waits for startup security work before prompting", () => {
  const state = makePromptState();

  assert.equal(
    claimLaunchTouchIdPrompt(state, makeStatus({ scrubbing: true })),
    false
  );
  assert.equal(claimLaunchTouchIdPrompt(state, makeStatus()), true);
});

test("does not auto-prompt if Touch ID was off at startup", () => {
  const state = makePromptState();

  assert.equal(
    claimLaunchTouchIdPrompt(state, makeStatus({ touchIdEnabled: false })),
    false
  );
  assert.equal(claimLaunchTouchIdPrompt(state, makeStatus()), false);
});
