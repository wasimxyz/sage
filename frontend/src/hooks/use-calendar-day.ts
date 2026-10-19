import { useSyncExternalStore } from "react";

import { calendarDateKey, msUntilNextDay } from "@/lib/format-date";

// A little past midnight, so the timer never fires just before the day turns.
const midnightSlackMs = 1000;

const listeners = new Set<() => void>();
let timer: number | undefined;

function scheduleNextDay() {
  timer = window.setTimeout(() => {
    for (const listener of listeners) {
      listener();
    }
    scheduleNextDay();
  }, msUntilNextDay(new Date()) + midnightSlackMs);
}

// One timer serves every subscriber, and it runs only while one is mounted.
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    scheduleNextDay();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };
}

function getToday(): string {
  return calendarDateKey(new Date());
}

/**
 * Today's local date as `yyyy-MM-dd`. It changes at midnight, so a label such
 * as Today turns into Yesterday without a reload.
 */
export function useCalendarDay(): string {
  return useSyncExternalStore(subscribe, getToday);
}
