import type { EventMemory } from "@/bridge";
import { eventAgeGroup } from "./format-date.ts";
import { eventDateKey, sortEventsByOccurredAt } from "./sort-events.ts";

export interface EventGroup {
  events: EventMemory[];
  key: string;
  title: string;
}

export function groupEvents(
  events: EventMemory[],
  now = new Date()
): {
  groups: EventGroup[];
  undated: EventMemory[];
} {
  const groups = new Map<string, EventGroup>();
  const undated: EventMemory[] = [];
  for (const row of sortEventsByOccurredAt(events)) {
    const period = eventAgeGroup(eventDateKey(row.occurredAt), now);
    if (!period) {
      undated.push(row);
      continue;
    }
    const existing = groups.get(period.key);
    if (existing) {
      existing.events.push(row);
      continue;
    }
    groups.set(period.key, {
      events: [row],
      key: period.key,
      title: period.title,
    });
  }
  return {
    groups: [...groups.values()].sort((left, right) =>
      right.key.localeCompare(left.key)
    ),
    undated,
  };
}
