// The inactivity periods Settings > Security and setup both offer. Mirrors
// `idle_timeout_options` in `src/lock.zig`, which refuses any other value.

export const idleTimeoutOptions = [
  { label: "Never", value: 0 },
  { label: "1 min", value: 60_000 },
  { label: "5 min", value: 300_000 },
  { label: "15 min", value: 900_000 },
  { label: "30 min", value: 1_800_000 },
] as const;

export const defaultIdleTimeoutMs = 300_000;

const msPerMinute = 60_000;

/**
 * The lock tip on the All set screen. It says what the lock does with the idle
 * time the person chose, or where to turn the lock on when it is off.
 */
export function lockTip(lock: {
  enabled: boolean;
  idleTimeoutMs: number;
}): string {
  if (!lock.enabled) {
    return "You can turn on a lock any time in Settings › Security.";
  }
  if (lock.idleTimeoutMs <= 0) {
    return "Sage locks when your Mac sleeps.";
  }
  const minutes = Math.round(lock.idleTimeoutMs / msPerMinute);
  const unit = minutes === 1 ? "minute" : "minutes";
  return `Sage locks when your Mac sleeps, and after ${minutes} ${unit} away.`;
}
