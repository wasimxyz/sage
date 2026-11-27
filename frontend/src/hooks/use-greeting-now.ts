import { useEffect, useState } from "react";

import { nextGreetingTick } from "@/lib/greeting";

// A little past the turn, so the timer never fires just before it.
const turnSlackMs = 1000;

/**
 * The current time, set again whenever the new chat's labels turn over: at
 * 5 AM, noon, 5 PM, and midnight. The greeting and the date read it, so
 * neither goes stale while Sage stays open.
 */
export function useGreetingNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const turn = nextGreetingTick(now).getTime();
    const timer = window.setTimeout(
      () => setNow(new Date()),
      turn - Date.now() + turnSlackMs
    );
    // A timer stands still while the Mac sleeps, so it can fire hours late.
    // Coming back to the window reads the clock again.
    const catchUp = () => {
      if (!document.hidden && Date.now() >= turn) {
        setNow(new Date());
      }
    };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, [now]);
  return now;
}
