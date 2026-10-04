import assert from "node:assert/strict";
import test from "node:test";

import { shouldKeepLockScreen } from "./lock-state.ts";

test("keeps the lock screen when lock status cannot be read", () => {
  assert.equal(
    shouldKeepLockScreen(null, "Could not check lock status."),
    true
  );
  assert.equal(
    shouldKeepLockScreen({ enabled: true, unlocked: true }, "Status failed."),
    true
  );
});

test("does not keep the lock screen while status is still loading", () => {
  assert.equal(shouldKeepLockScreen(null, null), false);
});

test("keeps the lock screen only while an enabled lock is locked", () => {
  assert.equal(
    shouldKeepLockScreen({ enabled: true, unlocked: false }, null),
    true
  );
  assert.equal(
    shouldKeepLockScreen({ enabled: true, unlocked: true }, null),
    false
  );
  assert.equal(
    shouldKeepLockScreen({ enabled: false, unlocked: true }, null),
    false
  );
});
