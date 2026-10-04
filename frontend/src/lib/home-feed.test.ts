import assert from "node:assert/strict";
import test from "node:test";

import type { HomeFeed, HomeFeedItem } from "../bridge.ts";
import { formatHomeHeadingDate } from "./format-date.ts";
import { groupHomeFeed, homeSinceDate } from "./home-feed.ts";

const now = new Date(2026, 8, 20);

function entry(id: number, date: string, title = `Entry ${id}`): HomeFeedItem {
  return {
    date,
    id,
    kind: "entry",
    snippet: "Body snippet",
    title,
  };
}

function conversation(
  id: number,
  date: string,
  title = `Chat ${id}`
): HomeFeedItem {
  return {
    date,
    id,
    kind: "conversation",
    snippet: "Assistant snippet",
    title,
  };
}

test("formatHomeHeadingDate uses weekday, month, and day", () => {
  assert.equal(
    formatHomeHeadingDate(new Date(2026, 8, 17)),
    "Thursday, September 17"
  );
});

test("homeSinceDate is 13 days before today", () => {
  assert.equal(homeSinceDate(now), "2026-09-07");
});

test("groupHomeFeed splits recent and older and skips the featured entry", () => {
  const feed: HomeFeed = {
    items: [
      conversation(4, "2026-09-19"),
      entry(10, "2026-09-18", "Featured"),
      entry(2, "2026-09-12"),
      conversation(5, "2026-09-07"),
      entry(3, "2026-09-06"),
    ],
    latest: {
      date: "2026-09-18",
      format: "plain",
      id: 10,
      snippet: "Keep writing",
      title: "Featured",
      updatedAt: "2026-09-18T12:00:00.000Z",
      wordCount: 12,
    },
  };
  const grouped = groupHomeFeed(feed, now);
  assert.deepEqual(
    grouped.recent.map((item) => item.id),
    [4]
  );
  assert.deepEqual(
    grouped.older.map((item) => item.id),
    [2, 5]
  );
});
