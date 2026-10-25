import { useEffect, useState } from "react";

import {
  getSystemCalendar,
  hasNativeBridge,
  waitForNativeBridge,
} from "@/bridge";
import { type WeekDay, weekStartsOnFrom } from "@/lib/home";

// The last answer, so Home does not wait for it on a later visit.
let lastKnown: WeekDay | null = null;

/**
 * The day the Mac's week starts on, from System Settings > General > Language
 * & Region. It is null until the first answer. If the Mac cannot answer, the
 * week starts on Sunday.
 */
export function useWeekStartsOn(): WeekDay | null {
  const [weekStartsOn, setWeekStartsOn] = useState(lastKnown);
  useEffect(() => {
    let cancelled = false;
    async function read() {
      try {
        if (!((await waitForNativeBridge()) && hasNativeBridge())) {
          throw new Error("No bridge.");
        }
        const { firstWeekday } = await getSystemCalendar();
        lastKnown = weekStartsOnFrom(firstWeekday);
      } catch {
        // Home still works with a Sunday week.
      }
      if (!cancelled) {
        setWeekStartsOn(lastKnown ?? 0);
      }
    }
    read().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return weekStartsOn;
}
