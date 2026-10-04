/**
 * A wait remainder in milliseconds as whole seconds for the lock screen. The
 * leftover rounds up, so a wait still in force never reads as zero — the
 * button would turn on a moment before Zig accepts a guess.
 */
export function waitSecondsFromMs(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}
