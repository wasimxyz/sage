import { differenceInCalendarDays } from "date-fns/differenceInCalendarDays";
import { subDays } from "date-fns/subDays";

import type { HomeFeed, HomeFeedItem } from "@/bridge";
import { calendarDateKey, parseCalendarDate } from "./format-date.ts";

export function homeSinceDate(now = new Date()): string {
  return calendarDateKey(subDays(now, 13));
}

export function groupHomeFeed(
  feed: HomeFeed,
  now = new Date()
): { older: HomeFeedItem[]; recent: HomeFeedItem[] } {
  const featuredId = feed.latest?.id ?? null;
  const older: HomeFeedItem[] = [];
  const recent: HomeFeedItem[] = [];
  for (const item of feed.items) {
    if (item.kind === "entry" && item.id === featuredId) {
      continue;
    }
    const date = parseCalendarDate(item.date);
    if (!date) {
      continue;
    }
    const days = differenceInCalendarDays(now, date);
    if (days < 0) {
      continue;
    }
    if (days < 7) {
      recent.push(item);
      continue;
    }
    if (days < 14) {
      older.push(item);
    }
  }
  return { older, recent };
}
