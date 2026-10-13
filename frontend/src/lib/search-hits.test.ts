import assert from "node:assert/strict";
import test from "node:test";

import { settledSearchQuery, visibleHits } from "./search-hits.ts";

test("settledSearchQuery on Journal is the journal stamp", () => {
  assert.equal(settledSearchQuery("journal", "fog", "", ""), "fog");
  assert.equal(settledSearchQuery("journal", "", "fog", "fog"), "");
});

test("settledSearchQuery on Conversations is the chat stamp", () => {
  assert.equal(settledSearchQuery("conversations", "mist", "fog", ""), "fog");
});

test("settledSearchQuery on Memories is the memory stamp", () => {
  assert.equal(settledSearchQuery("memories", "fog", "fog", "mist"), "mist");
  assert.equal(settledSearchQuery("memories", "", "", "fog", false), "");
});

test("settledSearchQuery on All needs every stamp to agree", () => {
  assert.equal(settledSearchQuery("all", "fog", "fog", "fog"), "fog");
  assert.equal(settledSearchQuery("all", "fog", "fog", ""), "");
  assert.equal(settledSearchQuery("all", "fog", "", "fog"), "");
  assert.equal(settledSearchQuery("all", "", "fog", "fog"), "");
  assert.equal(settledSearchQuery("all", "fo", "fo", "fo"), "fo");
});

test("settledSearchQuery on All ignores memory when memory is disabled", () => {
  assert.equal(settledSearchQuery("all", "fog", "fog", "", false), "fog");
  assert.equal(settledSearchQuery("all", "fog", "", "", false), "");
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
