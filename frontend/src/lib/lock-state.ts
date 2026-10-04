import type { LockStatus } from "@/bridge";

export function shouldKeepLockScreen(
  status: Pick<LockStatus, "enabled" | "unlocked"> | null,
  statusError: string | null
): boolean {
  return (
    statusError !== null || (Boolean(status?.enabled) && !status?.unlocked)
  );
}
