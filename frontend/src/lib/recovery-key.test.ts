import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRecoveryKey, recoveryKeysMatch } from "./recovery-key.ts";

const key = "7K2M9QXD3FHT8VWZ4BNC6PRG";
const shown = "7K2M-9QXD-3FHT-8VWZ-4BNC-6PRG";

test("normalizeRecoveryKey forgives case, dashes, and spacing", () => {
  assert.equal(normalizeRecoveryKey(shown), key);
  assert.equal(normalizeRecoveryKey(key), key);
  assert.equal(normalizeRecoveryKey(" 7k2m 9qxd-3fht-8vwz-4bnc-6prg\n"), key);
});

test("normalizeRecoveryKey reads look-alike letters the way Sage does", () => {
  assert.equal(
    normalizeRecoveryKey("OIL0-0000-0000-0000-0000-0000"),
    "011000000000000000000000"
  );
});

test("normalizeRecoveryKey refuses text that is not shaped like a key", () => {
  assert.equal(normalizeRecoveryKey(""), null);
  assert.equal(normalizeRecoveryKey("7K2M-9QXD"), null);
  assert.equal(normalizeRecoveryKey(`${shown}G`), null);
  // U is not in the alphabet.
  assert.equal(normalizeRecoveryKey("7K2M-9QXD-3FHT-8VWZ-4BNC-6PRU"), null);
  assert.equal(normalizeRecoveryKey("7K2M-9QXD-3FHT-8VWZ-4BNC-6PR!"), null);
});

test("recoveryKeysMatch compares what was typed with what was shown", () => {
  assert.equal(recoveryKeysMatch(shown, "7k2m9qxd3fht8vwz4bnc6prg"), true);
  assert.equal(
    recoveryKeysMatch(shown, "7K2M-9QXD-3FHT-8VWZ-4BNC-6PRH"),
    false
  );
  assert.equal(recoveryKeysMatch(shown, "7K2M-9QXD"), false);
  // A shown value that is not a key never matches, not even itself.
  assert.equal(recoveryKeysMatch("nope", "nope"), false);
});
