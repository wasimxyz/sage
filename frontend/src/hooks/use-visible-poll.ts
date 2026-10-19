import { useEffect, useRef } from "react";

/**
 * Runs `callback` every `intervalMs` while the window is visible. A hidden
 * window does no checks, and one runs as soon as the window comes back. The
 * caller makes the first check itself, when it mounts.
 */
export function useVisiblePoll(
  callback: () => void,
  intervalMs: number,
  enabled = true
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const check = () => {
      if (!document.hidden) {
        callbackRef.current();
      }
    };
    const timer = window.setInterval(check, intervalMs);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, intervalMs]);
}
