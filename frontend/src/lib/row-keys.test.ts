import assert from "node:assert/strict";
import test from "node:test";

import { isDeleteKey, isReturnKey } from "./row-keys.ts";

const plain = {
  altKey: false,
  ctrlKey: false,
  key: "a",
  metaKey: false,
  shiftKey: false,
};

test("command and backspace delete, and so does command and delete", () => {
  assert.equal(
    isDeleteKey({ ...plain, key: "Backspace", metaKey: true }),
    true
  );
  assert.equal(isDeleteKey({ ...plain, key: "Delete", metaKey: true }), true);
});

test("backspace alone, or with another modifier, does not delete", () => {
  assert.equal(isDeleteKey({ ...plain, key: "Backspace" }), false);
  assert.equal(
    isDeleteKey({ ...plain, key: "Backspace", metaKey: true, shiftKey: true }),
    false
  );
  assert.equal(
    isDeleteKey({ ...plain, altKey: true, key: "Backspace", metaKey: true }),
    false
  );
  assert.equal(isDeleteKey({ ...plain, key: "x", metaKey: true }), false);
});

test("return renames only on its own", () => {
  assert.equal(isReturnKey({ ...plain, key: "Enter" }), true);
  assert.equal(isReturnKey({ ...plain, key: "Enter", metaKey: true }), false);
  assert.equal(isReturnKey({ ...plain, key: "Enter", shiftKey: true }), false);
  assert.equal(isReturnKey({ ...plain, key: " " }), false);
});
