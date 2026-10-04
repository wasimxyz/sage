import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryEnabledFrom,
  memoryFeatureEnabled,
} from "../agent/lib/memory-feature-state.ts";

test("memoryEnabledFrom defaults to false for missing or malformed values", () => {
  assert.equal(memoryEnabledFrom({ memory: true }), true);
  assert.equal(memoryEnabledFrom({ memory: false }), false);
  assert.equal(memoryEnabledFrom({ memory: "true" }), false);
  assert.equal(memoryEnabledFrom({}), false);
  assert.equal(memoryEnabledFrom(null), false);
});

test("memoryFeatureEnabled fails closed on HTTP, JSON, and transport errors", async () => {
  assert.equal(
    await memoryFeatureEnabled(async () => new Response('{"memory":true}')),
    true
  );
  assert.equal(
    await memoryFeatureEnabled(
      async () => new Response('{"memory":true}', { status: 503 })
    ),
    false
  );
  assert.equal(
    await memoryFeatureEnabled(async () => new Response("not json")),
    false
  );
  assert.equal(
    await memoryFeatureEnabled(() =>
      Promise.reject(new Error("server unavailable"))
    ),
    false
  );
});

test("memoryFeatureEnabled shares nearby requests and expires the result", async () => {
  let calls = 0;
  const fetchFeature = () => {
    calls += 1;
    return Promise.resolve(Response.json({ memory: calls === 1 }));
  };

  assert.equal(await memoryFeatureEnabled(fetchFeature, 1000), true);
  assert.equal(await memoryFeatureEnabled(fetchFeature, 1500), true);
  assert.equal(calls, 1);
  assert.equal(await memoryFeatureEnabled(fetchFeature, 2001), false);
  assert.equal(calls, 2);
});

test("memoryFeatureEnabled retries a failed lookup instead of caching off", async () => {
  let calls = 0;
  const fetchFeature = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("bridge unavailable"));
    }
    return Promise.resolve(new Response('{"memory":true}'));
  };

  assert.equal(await memoryFeatureEnabled(fetchFeature, 1000), false);
  assert.equal(await memoryFeatureEnabled(fetchFeature, 1001), true);
  assert.equal(calls, 2);
});
