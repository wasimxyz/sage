import assert from "node:assert/strict";
import test from "node:test";

import { formatImportError } from "./import-errors.ts";

test("formatImportError maps lock and missing-entry errors", () => {
  assert.equal(
    formatImportError(new Error("handler_failed: Locked")),
    "Unlock the app first."
  );
  assert.equal(
    formatImportError(new Error("handler_failed: NotFound")),
    "An entry could not be found."
  );
});

test("formatImportError preserves the safe partial-import summary", () => {
  assert.equal(
    formatImportError(new Error("Imported 1 of 3 entries.")),
    "Imported 1 of 3 entries."
  );
});

test("formatImportError hides unknown Node and OS messages", () => {
  assert.equal(
    formatImportError(new Error("connect ECONNREFUSED /Users/private/journal")),
    "Could not import these entries."
  );
  assert.equal(formatImportError(null), "Could not import these entries.");
});
