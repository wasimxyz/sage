import { useEffect, useState } from "react";

import { nextHomeChange } from "@/lib/home";

// A little past the turn, so the timer never fires just before it.
const turnSlackMs = 1000;

/**
 * The current time, set again whenever Home's labels turn over: at 5 AM, noon,
 * 5 PM, and midnight. Home reads its greeting and its month from this, so
 * neither goes stale while Sage stays open.
 */
export function useHomeNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const wait = nextHomeChange(now).getTime() - Date.now() + turnSlackMs;
    const timer = window.setTimeout(() => setNow(new Date()), wait);
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
}
