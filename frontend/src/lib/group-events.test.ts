import assert from "node:assert/strict";
import test from "node:test";

import type { EventMemory } from "../bridge.ts";
import { formatEventAge } from "./format-date.ts";
import { groupEvents } from "./group-events.ts";

function event(input: {
  event: string;
  id: number;
  occurredAt: string;
  updatedAt: string;
}): EventMemory {
  return {
    event: input.event,
    id: input.id,
    occurredAt: input.occurredAt,
    pinned: true,
    sourceId: 0,
    sourceTitle: "",
    sourceType: "user",
    updatedAt: input.updatedAt,
  };
}

test("formatEventAge names groups by week, then month, then year", () => {
  const now = new Date(2026, 8, 19);
  assert.equal(formatEventAge("2026-09-13", now), "This week");
  assert.equal(formatEventAge("2026-09-06", now), "1 week ago");
  assert.equal(formatEventAge("2026-08-23", now), "3 weeks ago");
  assert.equal(formatEventAge("2026-09-20", now), "In 1 week");
  assert.equal(formatEventAge("2026-08-01", now), "1 month ago");
  assert.equal(formatEventAge("2026-07-04", now), "2 months ago");
  assert.equal(formatEventAge("2025-03-10", now), "1 year ago");
});

test("groupEvents keeps events from the same week together", () => {
  const now = new Date(2026, 8, 19);
  const grouped = groupEvents(
    [
      event({
        event: "Thursday walk",
        id: 2,
        occurredAt: "2026-08-20",
        updatedAt: "2026-09-01T12:00:00.000Z",
      }),
      event({
        event: "Later month",
        id: 1,
        occurredAt: "2026-09-01",
        updatedAt: "2026-09-02T12:00:00.000Z",
      }),
      event({
        event: "Saturday market",
        id: 3,
        occurredAt: "2026-08-22",
        updatedAt: "2026-09-03T12:00:00.000Z",
      }),
    ],
    now
  );
  assert.deepEqual(
    grouped.groups.map((group) => group.key),
    ["2026-08-30", "2026-08-16"]
  );
  assert.equal(grouped.groups[0]?.title, "2 weeks ago");
  assert.equal(grouped.groups[1]?.title, "4 weeks ago");
  assert.deepEqual(
    grouped.groups[1]?.events.map((row) => row.event),
    ["Saturday market", "Thursday walk"]
  );
});

test("groupEvents folds older events into months and years", () => {
  const now = new Date(2026, 8, 19);
  const grouped = groupEvents(
    [
      event({
        event: "July swim",
        id: 2,
        occurredAt: "2026-07-04",
        updatedAt: "2026-07-05T12:00:00.000Z",
      }),
      event({
        event: "August trip",
        id: 1,
        occurredAt: "2026-08-01",
        updatedAt: "2026-08-02T12:00:00.000Z",
      }),
      event({
        event: "Later July",
        id: 3,
        occurredAt: "2026-07-20",
        updatedAt: "2026-07-21T12:00:00.000Z",
      }),
      event({
        event: "Last spring",
        id: 4,
        occurredAt: "2025-03-10",
        updatedAt: "2025-03-11T12:00:00.000Z",
      }),
    ],
    now
  );
  assert.deepEqual(
    grouped.groups.map((group) => [group.key, group.title]),
    [
      ["2026-08-01", "1 month ago"],
      ["2026-07-01", "2 months ago"],
      ["2025-01-01", "1 year ago"],
    ]
  );
  assert.deepEqual(
    grouped.groups[1]?.events.map((row) => row.event),
    ["Later July", "July swim"]
  );
});

test("groupEvents puts events with no date last", () => {
  const grouped = groupEvents([
    event({
      event: "Unknown date",
      id: 4,
      occurredAt: "unknown",
      updatedAt: "2026-09-19T12:00:00.000Z",
    }),
    event({
      event: "Walked",
      id: 1,
      occurredAt: "2026-08-20",
      updatedAt: "2026-09-01T12:00:00.000Z",
    }),
  ]);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(
    grouped.undated.map((row) => row.event),
    ["Unknown date"]
  );
});
