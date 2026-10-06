import type {
  LockStatus,
  OllamaSetupStatus,
  OnboardingState,
  OnboardingStatus,
  OnboardingStep,
  UnlockMethod,
} from "@/bridge";

// The decisions behind first-launch setup, kept free of React and the bridge
// so each one can be tested. The core stores the rows and the page reads them
// through `onboarding.status`; `docs/onboarding.md` explains the flow.

const dayMs = 86_400_000;

/** How many times Sage asks before it stops. Mirrors `max_reminders` in `src/onboarding.zig`. */
export const maxReminders = 3;

/**
 * How long Sage waits before the 1st, 2nd, and 3rd reminder, counted from the
 * one before it. The 1st can show on any later launch.
 */
const reminderWaitMs = [0, 3 * dayMs, 7 * dayMs] as const;

export type LaunchScreen =
  | { kind: "home" }
  | { kind: "setup"; step: OnboardingStep };

/**
 * Which screen a launch opens. A missing state means a new person, so setup
 * starts at Welcome. An active state means setup was left half done, so it
 * opens where the person stopped. Done and skipped open Home.
 */
export function launchScreen(
  status: Pick<OnboardingStatus, "state" | "step">
): LaunchScreen {
  if (status.state === null) {
    return { kind: "setup", step: "welcome" };
  }
  if (status.state === "active") {
    return { kind: "setup", step: status.step };
  }
  return { kind: "home" };
}

export type OllamaScreen = "downloads" | "install" | "start";

/**
 * Which Local AI screen to show. A running Ollama goes straight to the
 * downloads. One that is installed but not running gets a start first, and
 * one that is not installed gets the install steps.
 */
export function ollamaScreen(
  status: Pick<OllamaSetupStatus, "installed" | "running">
): OllamaScreen {
  if (status.running) {
    return "downloads";
  }
  return status.installed ? "start" : "install";
}

/**
 * Step 1 has nothing left to do when Ollama runs and already has both models,
 * so setup skips it. Null means Sage has not looked yet.
 */
export function localAiDone(
  readiness: { embed: boolean; running: boolean; summary: boolean } | null
): boolean {
  return Boolean(readiness?.running && readiness.embed && readiness.summary);
}

export type ProtectScreen = "choose" | "done" | "encrypt";

/**
 * Which Protect screen to show for the lock as it is right now. With no lock,
 * the person chooses how to unlock. With a lock and no encryption, the choice
 * is already made, so Sage goes straight to encryption. With both on, there
 * is nothing left to ask.
 */
export function protectScreen(
  lock: Pick<LockStatus, "enabled" | "encrypted">
): ProtectScreen {
  if (!lock.enabled) {
    return "choose";
  }
  return lock.encrypted ? "done" : "encrypt";
}

/**
 * The Protect screen for first-launch setup. It is `protectScreen`, except that
 * someone who already chose a lock and turned encryption off is not asked
 * again when they come back with Back. The reminder never uses this: a person
 * who taps Set up now wants the offer.
 */
export function setupProtectScreen(
  lock: Pick<LockStatus, "enabled" | "encrypted">,
  saved: Pick<OnboardingStatus, "encrypt" | "method">
): ProtectScreen {
  const screen = protectScreen(lock);
  if (screen === "encrypt" && saved.method !== null && !saved.encrypt) {
    return "done";
  }
  return screen;
}

/**
 * The unlock method that starts picked. Touch ID needs a fingerprint sensor:
 * a Mac that only offers its login password gets Password.
 */
export function defaultUnlockMethod(
  lock: Pick<LockStatus, "touchIdBiometrics">
): UnlockMethod {
  return lock.touchIdBiometrics ? "touch_id" : "password";
}

/** The Touch ID choice only shows on a Mac with a fingerprint sensor. */
export function touchIdChoiceAvailable(
  lock: Pick<LockStatus, "touchIdBiometrics">
): boolean {
  return lock.touchIdBiometrics;
}

/** Everything the schedule reads, so a test can set each piece. */
export interface ReminderInput {
  encrypted: boolean;
  nowMs: number;
  ranSetupThisLaunch: boolean;
  reminderLastAtMs: number;
  reminderShownThisLaunch: boolean;
  remindersOff: boolean;
  remindersShown: number;
  state: OnboardingState | null;
}

export type ReminderNumber = 1 | 2 | 3;

/**
 * Which reminder to show on this launch, or null for none. A reminder needs
 * setup to be over, encryption to be off, reminders to be on, and fewer than
 * three to have shown. It never shows on the launch that ran setup or twice in
 * one launch. The 2nd waits 3 days after the 1st, and the 3rd waits 7 days
 * after the 2nd.
 *
 * A last-shown time in the future means the clock moved back. That counts as
 * enough time, so a wrong clock cannot silence the reminders for good.
 */
export function reminderDue(input: ReminderInput): ReminderNumber | null {
  if (input.state !== "done" && input.state !== "skipped") {
    return null;
  }
  if (input.encrypted || input.remindersOff) {
    return null;
  }
  if (input.ranSetupThisLaunch || input.reminderShownThisLaunch) {
    return null;
  }
  if (input.remindersShown >= maxReminders || input.remindersShown < 0) {
    return null;
  }
  const next = input.remindersShown + 1;
  if (next === 1) {
    return 1;
  }
  const waitMs = reminderWaitMs[next - 1] ?? 0;
  const sinceLastMs = input.nowMs - input.reminderLastAtMs;
  const enough =
    input.reminderLastAtMs <= 0 || sinceLastMs < 0 || sinceLastMs >= waitMs;
  if (!enough) {
    return null;
  }
  return next === 2 ? 2 : 3;
}

/**
 * The banner at the top of the Import step: what is on now. Null when nothing
 * is, so a person who skipped Protect sees no banner.
 */
export function protectionBanner(
  lock: Pick<LockStatus, "enabled" | "encrypted">
): string | null {
  if (!lock.enabled) {
    return null;
  }
  return lock.encrypted ? "Lock and encryption are on." : "Lock is on.";
}

/** The protection row on All set, from the lock as it is. */
export function protectionLine(
  lock: Pick<LockStatus, "enabled" | "encrypted">
): { on: boolean; text: string } {
  if (!lock.enabled) {
    return { on: false, text: "Lock and encryption are off" };
  }
  return lock.encrypted
    ? { on: true, text: "Lock and encryption are on" }
    : { on: true, text: "Lock is on, encryption is off" };
}

/** The line under the 1st and 2nd reminder's buttons. */
export function remindersLeftLine(reminder: ReminderNumber): string {
  const left = maxReminders - reminder;
  return left === 1
    ? "Sage will ask 1 more time."
    : `Sage will ask ${left} more times.`;
}
