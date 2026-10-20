import { useEffect, useEffectEvent } from "react";

import { documentPollHost, startVisiblePoll } from "@/lib/visible-poll";

/**
 * Runs `check` when it mounts, then `intervalMs` after each check ends, while
 * the window is visible. A hidden window does no checks, and one runs as soon
 * as the window comes back. `leading: false` skips the first check.
 */
export function useVisiblePoll(
  check: () => Promise<void>,
  intervalMs: number,
  {
    enabled = true,
    leading = true,
  }: { enabled?: boolean; leading?: boolean } = {}
) {
  const onCheck = useEffectEvent(check);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return startVisiblePoll({
      check: () => onCheck(),
      delayMs: intervalMs,
      host: documentPollHost,
      leading,
    });
  }, [enabled, intervalMs, leading]);
}
