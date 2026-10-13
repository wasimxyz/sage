import assert from "node:assert/strict";
import test from "node:test";

import { type ModelsLoad, sameModelsLoad } from "./models-load.ts";

const ready = (...names: string[]): ModelsLoad => ({ kind: "ready", names });

test("two checks of the same plain state match", () => {
  assert.equal(sameModelsLoad({ kind: "down" }, { kind: "down" }), true);
  assert.equal(sameModelsLoad({ kind: "empty" }, { kind: "empty" }), true);
  assert.equal(sameModelsLoad({ kind: "loading" }, { kind: "loading" }), true);
});

test("different states do not match", () => {
  assert.equal(sameModelsLoad({ kind: "down" }, { kind: "empty" }), false);
  assert.equal(sameModelsLoad({ kind: "down" }, ready("a")), false);
  assert.equal(sameModelsLoad(ready("a"), { kind: "empty" }), false);
});

test("ready matches only when the names match in order", () => {
  assert.equal(sameModelsLoad(ready("a", "b"), ready("a", "b")), true);
  assert.equal(sameModelsLoad(ready("a", "b"), ready("b", "a")), false);
  assert.equal(sameModelsLoad(ready("a"), ready("a", "b")), false);
  assert.equal(sameModelsLoad(ready(), ready()), true);
});
