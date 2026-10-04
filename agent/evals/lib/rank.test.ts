import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCurrentAndStale,
  currentOutranksStale,
} from "./rank.ts";

const current = "Sam is the user's boyfriend or partner";
const stale = "Sam is the user's friend or climbing partner";

test("current-first when the current claim ranks above the stale one", () => {
  const order = compareCurrentAndStale(
    [`Sam: ${current}`, `Sam: ${stale}`],
    current,
    stale
  );
  assert.equal(order, "current-first");
  assert.equal(currentOutranksStale(order), true);
});

test("stale-first when the older claim still ranks higher", () => {
  const order = compareCurrentAndStale(
    [`Sam: ${stale}`, `Sam: ${current}`],
    current,
    stale
  );
  assert.equal(order, "stale-first");
  assert.equal(currentOutranksStale(order), false);
});

test("current-only when the stale claim is absent", () => {
  const order = compareCurrentAndStale([`Sam: ${current}`], current, stale);
  assert.equal(order, "current-only");
  assert.equal(currentOutranksStale(order), true);
});

test("missing when neither claim appears", () => {
  assert.equal(
    compareCurrentAndStale(["Alex: they reconciled"], current, stale),
    "missing"
  );
});
