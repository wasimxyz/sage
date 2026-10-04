import assert from "node:assert/strict";
import test from "node:test";

import type { EventMemory } from "../bridge.ts";
import { sortEventsByOccurredAt } from "./sort-events.ts";

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

test("sortEventsByOccurredAt uses event time, not updated time", () => {
  const sorted = sortEventsByOccurredAt([
    event({
      event: "Earlier walk",
      id: 2,
      occurredAt: "2026-08-01",
      updatedAt: "2026-09-19T12:00:00.000Z",
    }),
    event({
      event: "Later trip",
      id: 1,
      occurredAt: "2026-09-01",
      updatedAt: "2026-09-10T12:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.event),
    ["Later trip", "Earlier walk"]
  );
});

test("sortEventsByOccurredAt puts events with no date last", () => {
  const sorted = sortEventsByOccurredAt([
    event({
      event: "Unknown date",
      id: 4,
      occurredAt: "unknown",
      updatedAt: "2026-09-19T12:00:00.000Z",
    }),
    event({
      event: "Undated note",
      id: 3,
      occurredAt: "  ",
      updatedAt: "2026-09-19T12:00:00.000Z",
    }),
    event({
      event: "Walked",
      id: 1,
      occurredAt: "2026-08-01",
      updatedAt: "2026-09-01T12:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.event),
    ["Walked", "Unknown date", "Undated note"]
  );
});
