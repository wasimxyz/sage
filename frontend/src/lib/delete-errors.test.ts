import assert from "node:assert/strict";
import test from "node:test";

import { deleteFailure } from "./delete-errors.ts";

test("a locked or securing app asks for another try", () => {
  assert.equal(deleteFailure(new Error("handler_failed: Locked")), "locked");
  assert.equal(deleteFailure(new Error("Securing")), "locked");
  assert.equal(deleteFailure("Sage is locked."), "locked");
  assert.equal(
    deleteFailure(new Error("Sage is securing your journal.")),
    "locked"
  );
});

test("a missing row counts as already deleted", () => {
  assert.equal(deleteFailure(new Error("handler_failed: NotFound")), "missing");
  assert.equal(deleteFailure(new Error("Entry not found.")), "missing");
});

test("anything else is a real failure", () => {
  assert.equal(deleteFailure(new Error("disk is full")), "other");
  assert.equal(deleteFailure(undefined), "other");
  assert.equal(deleteFailure({}), "other");
});
