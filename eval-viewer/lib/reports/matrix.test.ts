import assert from "node:assert/strict";
import test from "node:test";

import {
  dreamChatKey,
  filterByEmbed,
  groupRunsByDate,
  latestByDreamChat,
  resolveEmbedModel,
  uniqueInOrder,
} from "./matrix.ts";
import type { RunSummary } from "./types.ts";

function summary(partial: {
  chatModel: string;
  dreamModel: string;
  embedModel: string;
  id: string;
  startedAt: string;
}): RunSummary {
  return {
    failed: 0,
    infraFailed: 0,
    passed: 10,
    suiteSeconds: 1,
    total: 10,
    ...partial,
  };
}

test("uniqueInOrder keeps first-seen values", () => {
  assert.deepEqual(uniqueInOrder(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
});

test("resolveEmbedModel prefers the requested model when it exists", () => {
  const runs = [
    summary({
      chatModel: "gemma3:12b",
      dreamModel: "gemma3:12b",
      embedModel: "nomic-embed-text",
      id: "a",
      startedAt: "2026-09-16T06:19:00Z",
    }),
    summary({
      chatModel: "phi4:14b",
      dreamModel: "phi4:14b",
      embedModel: "other-embed",
      id: "b",
      startedAt: "2026-09-16T05:00:00Z",
    }),
  ];
  assert.equal(resolveEmbedModel(runs, "other-embed"), "other-embed");
  assert.equal(resolveEmbedModel(runs, "missing"), "nomic-embed-text");
  assert.equal(resolveEmbedModel(runs, undefined), "nomic-embed-text");
});

test("latestByDreamChat keeps the newest run for a cell", () => {
  const older = summary({
    chatModel: "gemma3:12b",
    dreamModel: "gemma3:12b",
    embedModel: "nomic-embed-text",
    id: "older",
    startedAt: "2026-09-16T02:00:00Z",
  });
  const newer = summary({
    chatModel: "gemma3:12b",
    dreamModel: "gemma3:12b",
    embedModel: "nomic-embed-text",
    id: "newer",
    startedAt: "2026-09-16T06:19:00Z",
  });
  const other = summary({
    chatModel: "phi4:14b",
    dreamModel: "gemma3:12b",
    embedModel: "nomic-embed-text",
    id: "other",
    startedAt: "2026-09-16T03:00:00Z",
  });
  const latest = latestByDreamChat([older, newer, other]);
  assert.equal(
    latest.get(dreamChatKey("gemma3:12b", "gemma3:12b"))?.id,
    "newer"
  );
  assert.equal(latest.get(dreamChatKey("gemma3:12b", "phi4:14b"))?.id, "other");
});

test("filterByEmbed then latestByDreamChat ignores other embeddings", () => {
  const nomic = summary({
    chatModel: "qwen3:8b",
    dreamModel: "qwen3:8b",
    embedModel: "nomic-embed-text",
    id: "nomic",
    startedAt: "2026-09-16T06:19:00Z",
  });
  const other = summary({
    chatModel: "qwen3:8b",
    dreamModel: "qwen3:8b",
    embedModel: "other-embed",
    id: "other",
    startedAt: "2026-09-16T07:00:00Z",
  });
  const latest = latestByDreamChat(
    filterByEmbed([nomic, other], "nomic-embed-text")
  );
  assert.equal(latest.get(dreamChatKey("qwen3:8b", "qwen3:8b"))?.id, "nomic");
});

test("groupRunsByDate buckets by UTC day", () => {
  const first = summary({
    chatModel: "a",
    dreamModel: "a",
    embedModel: "e",
    id: "first",
    startedAt: "2026-09-16T06:19:00Z",
  });
  const second = summary({
    chatModel: "b",
    dreamModel: "b",
    embedModel: "e",
    id: "second",
    startedAt: "2026-09-16T02:00:00Z",
  });
  const previous = summary({
    chatModel: "c",
    dreamModel: "c",
    embedModel: "e",
    id: "previous",
    startedAt: "2026-09-15T23:00:00Z",
  });
  const groups = groupRunsByDate([first, second, previous]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.key, "2026-09-16");
  assert.deepEqual(
    groups[0]?.runs.map((run) => run.id),
    ["first", "second"]
  );
  assert.equal(groups[1]?.key, "2026-09-15");
});
