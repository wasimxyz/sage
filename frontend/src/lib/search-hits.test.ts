import assert from "node:assert/strict";
import test from "node:test";

import { searchHitsReady, visibleHits } from "./search-hits.ts";

test("searchHitsReady is false for an empty query", () => {
  assert.equal(searchHitsReady("all", "", "fog", "fog", "fog"), false);
  assert.equal(searchHitsReady("journal", "", "fog", "", ""), false);
  assert.equal(searchHitsReady("memories", "", "", "", "fog"), false);
});

test("searchHitsReady on Journal only needs the journal stamp", () => {
  assert.equal(searchHitsReady("journal", "fog", "fog", "", ""), true);
  assert.equal(searchHitsReady("journal", "fog", "mist", "", ""), false);
});

test("searchHitsReady on Conversations only needs the chat stamp", () => {
  assert.equal(searchHitsReady("conversations", "fog", "", "fog", ""), true);
  assert.equal(
    searchHitsReady("conversations", "fog", "fog", "mist", ""),
    false
  );
});

test("searchHitsReady on Memories only needs the memory stamp", () => {
  assert.equal(searchHitsReady("memories", "fog", "", "", "fog"), true);
  assert.equal(searchHitsReady("memories", "fog", "fog", "fog", "mist"), false);
});

test("searchHitsReady on All needs every stamp", () => {
  assert.equal(searchHitsReady("all", "fog", "fog", "fog", "fog"), true);
  assert.equal(searchHitsReady("all", "fog", "fog", "fog", ""), false);
  assert.equal(searchHitsReady("all", "fog", "fog", "", "fog"), false);
  assert.equal(searchHitsReady("all", "fog", "", "fog", "fog"), false);
  assert.equal(searchHitsReady("all", "world", "fog", "fog", "fog"), false);
});

test("searchHitsReady on All does not wait for memory when memory is disabled", () => {
  assert.equal(searchHitsReady("all", "fog", "fog", "fog", "", false), true);
  assert.equal(searchHitsReady("all", "fog", "fog", "", "", false), false);
  assert.equal(searchHitsReady("memories", "fog", "", "", "", false), false);
});

test("visibleHits follows the selected tab", () => {
  const journal = [{ id: 1 }];
  const conversations = [{ id: 2 }];
  const memories = [{ id: 3 }];
  assert.deepEqual(visibleHits("journal", journal, conversations, memories), [
    { kind: "journal", result: { id: 1 } },
  ]);
  assert.deepEqual(
    visibleHits("conversations", journal, conversations, memories),
    [{ kind: "conversation", result: { id: 2 } }]
  );
  assert.deepEqual(visibleHits("memories", journal, conversations, memories), [
    { kind: "memory", result: { id: 3 } },
  ]);
  assert.deepEqual(visibleHits("all", journal, conversations, memories), [
    { kind: "journal", result: { id: 1 } },
    { kind: "conversation", result: { id: 2 } },
    { kind: "memory", result: { id: 3 } },
  ]);
});
