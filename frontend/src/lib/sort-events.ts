import type { EventMemory } from "@/bridge";

const eventDatePrefixPattern = /^\d{4}-\d{2}-\d{2}/;

export function eventDateKey(value: string): string {
  const trimmed = value.trim();
  return eventDatePrefixPattern.test(trimmed) ? trimmed : "";
}

export function sortEventsByOccurredAt(events: EventMemory[]): EventMemory[] {
  return [...events].sort((left, right) => {
    const leftAt = eventDateKey(left.occurredAt);
    const rightAt = eventDateKey(right.occurredAt);
    if (leftAt.length === 0 && rightAt.length === 0) {
      return right.id - left.id;
    }
    if (leftAt.length === 0) {
      return 1;
    }
    if (rightAt.length === 0) {
      return -1;
    }
    const byDate = rightAt.localeCompare(leftAt);
    if (byDate !== 0) {
      return byDate;
    }
    return right.id - left.id;
  });
}
