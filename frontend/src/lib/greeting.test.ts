import assert from "node:assert/strict";
import test from "node:test";

import {
  greetingFor,
  nextGreetingChange,
  nextGreetingTick,
} from "./greeting.ts";

// Every instant is built from local parts, so the answers do not depend on the
// time zone the tests run in.

test("the greeting follows the hour", () => {
  const at = (hour: number, minute: number) =>
    greetingFor(new Date(2026, 9, 24, hour, minute));
  assert.equal(at(4, 59), "Good evening.");
  assert.equal(at(5, 0), "Good morning.");
  assert.equal(at(11, 59), "Good morning.");
  assert.equal(at(12, 0), "Good afternoon.");
  assert.equal(at(16, 59), "Good afternoon.");
  assert.equal(at(17, 0), "Good evening.");
  assert.equal(at(0, 0), "Good evening.");
});

test("the greeting changes at 5 AM, noon, and 5 PM", () => {
  const next = (hour: number, minute = 0) =>
    nextGreetingChange(new Date(2026, 9, 24, hour, minute));
  assert.deepEqual(next(3), new Date(2026, 9, 24, 5));
  assert.deepEqual(next(5), new Date(2026, 9, 24, 12));
  assert.deepEqual(next(11, 59), new Date(2026, 9, 24, 12));
  assert.deepEqual(next(16, 59), new Date(2026, 9, 24, 17));
  assert.deepEqual(next(17), new Date(2026, 9, 25, 5));
  assert.deepEqual(
    nextGreetingChange(new Date(2026, 11, 31, 23)),
    new Date(2027, 0, 1, 5)
  );
});

test("the greeting and date turn over at the next greeting or at midnight", () => {
  assert.deepEqual(
    nextGreetingTick(new Date(2026, 9, 24, 13)),
    new Date(2026, 9, 24, 17)
  );
  assert.deepEqual(
    nextGreetingTick(new Date(2026, 9, 24, 17, 30)),
    new Date(2026, 9, 25)
  );
  assert.deepEqual(
    nextGreetingTick(new Date(2026, 9, 24, 23, 59)),
    new Date(2026, 9, 25)
  );
  assert.deepEqual(
    nextGreetingTick(new Date(2026, 9, 24, 0, 30)),
    new Date(2026, 9, 24, 5)
  );
});
