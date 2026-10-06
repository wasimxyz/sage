import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultIdleTimeoutMs,
  idleTimeoutOptions,
  lockTip,
} from "./idle-timeout.ts";

test("the default idle time is one of the choices", () => {
  assert.ok(
    idleTimeoutOptions.some(({ value }) => value === defaultIdleTimeoutMs)
  );
});

test("the lock tip names the idle time the person chose", () => {
  assert.equal(
    lockTip({ enabled: true, idleTimeoutMs: 300_000 }),
    "Sage locks when your Mac sleeps, and after 5 minutes away."
  );
  assert.equal(
    lockTip({ enabled: true, idleTimeoutMs: 60_000 }),
    "Sage locks when your Mac sleeps, and after 1 minute away."
  );
});

test("the lock tip drops the idle time when it is never", () => {
  assert.equal(
    lockTip({ enabled: true, idleTimeoutMs: 0 }),
    "Sage locks when your Mac sleeps."
  );
});

test("the lock tip points to Settings when the lock is off", () => {
  assert.equal(
    lockTip({ enabled: false, idleTimeoutMs: 300_000 }),
    "You can turn on a lock any time in Settings › Security."
  );
});
