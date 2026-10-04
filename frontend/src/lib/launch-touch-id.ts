import type { LockStatus } from "@/bridge";

export interface LaunchTouchIdPromptState {
  checked: boolean;
  eligible: boolean;
  prompted: boolean;
}

/**
 * Claims the one automatic Touch ID prompt when the app starts locked. Keep
 * this state in LockProvider so remounting the lock screen cannot prompt again.
 */
export function claimLaunchTouchIdPrompt(
  state: LaunchTouchIdPromptState,
  status: LockStatus
): boolean {
  if (!state.checked) {
    state.checked = true;
    state.eligible =
      status.enabled && !status.unlocked && status.touchIdEnabled;
  }

  if (!state.eligible || state.prompted) {
    return false;
  }
  if (!status.enabled || status.unlocked || !status.touchIdEnabled) {
    state.eligible = false;
    return false;
  }
  if (status.scrubbing || status.securing) {
    return false;
  }

  state.prompted = true;
  return true;
}
