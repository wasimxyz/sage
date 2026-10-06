import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getOnboardingStatus,
  hasNativeBridge,
  markReminderShown,
  type OnboardingStatus,
  type OnboardingStep,
  saveOnboarding,
  turnRemindersOff,
  type UnlockMethod,
  waitForNativeBridge,
} from "@/bridge";
import { useJournal } from "@/components/journal-context";
import { launchScreen } from "@/lib/onboarding";
import { replaceRoute } from "@/lib/route";

/**
 * What fills the window. `setup` is first-launch setup, with its saved step.
 * `protect` is the reminder's Set up now: the Protect screens on their own.
 * Both cover the whole window, with no sidebar.
 */
export type OnboardingMode =
  | { kind: "home" }
  | { kind: "loading" }
  | { kind: "protect" }
  | { kind: "setup"; step: OnboardingStep };

interface OnboardingState {
  mode: OnboardingMode;
  /** Null until Sage has read it, and when it could not be read. */
  status: OnboardingStatus | null;
}

interface OnboardingActions {
  /** Leave the Protect screens that Set up now opened, back to Home. */
  closeProtect: () => void;
  /** Mark setup done. The All set screen does this when it shows. */
  finishSetup: () => void;
  goTo: (step: OnboardingStep) => void;
  /** Leave setup for Home. */
  leaveSetup: () => void;
  /** Leave setup for a new entry in the editor. */
  leaveSetupToDraft: () => void;
  /** Open the Protect screens from the reminder. */
  openProtect: () => void;
  /** Count the reminder that is about to show. */
  recordReminderShown: () => Promise<void>;
  /** Remember the Protect choices, so a refresh keeps them. */
  rememberChoice: (choice: { encrypt: boolean; method: UnlockMethod }) => void;
  /** Skip setup. Model downloads that already started keep running. */
  skipSetup: () => Promise<void>;
  /** Don't ask again. */
  stopReminders: () => Promise<void>;
}

interface OnboardingContextValue {
  actions: OnboardingActions;
  state: OnboardingState;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const value = use(OnboardingContext);
  if (!value) {
    throw new Error("OnboardingProvider is missing.");
  }
  return value;
}

/**
 * Decides at launch whether to show setup or Home, and keeps setup's progress.
 * It mounts under the lock, so it runs after any unlock, and a refresh or an
 * unlock picks setup up at the step the person left. The core stores the rows
 * and decides who counts as an existing user.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const {
    actions: { startDraft },
  } = useJournal();
  const [mode, setMode] = useState<OnboardingMode>({ kind: "loading" });
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const draftAfterHome = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readLaunch()
      .then((launch) => {
        if (!cancelled) {
          setStatus(launch.status);
          setMode(launch.mode);
        }
      })
      .catch(() => {
        // A status that cannot be read never traps someone outside Home.
        if (!cancelled) {
          setMode({ kind: "home" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A new entry starts after Home has mounted and read the URL, or route sync
  // would put the person back on Home.
  useEffect(() => {
    if (mode.kind !== "home" || !draftAfterHome.current) {
      return;
    }
    draftAfterHome.current = false;
    startDraft().catch(() => undefined);
  }, [mode.kind, startDraft]);

  const goTo = useCallback((step: OnboardingStep) => {
    setMode({ kind: "setup", step });
    saveOnboarding({ step }).catch(() => undefined);
  }, []);

  const markEnded = useCallback((state: "done" | "skipped") => {
    setStatus((previous) =>
      previous ? { ...previous, ranSetupThisLaunch: true, state } : previous
    );
  }, []);

  const skipSetup = useCallback(async () => {
    await saveOnboarding({ state: "skipped" }).catch(() => undefined);
    markEnded("skipped");
    setMode({ kind: "home" });
  }, [markEnded]);

  const finishSetup = useCallback(() => {
    saveOnboarding({ state: "done", step: "all_set" }).catch(() => undefined);
    markEnded("done");
  }, [markEnded]);

  const leaveSetup = useCallback(() => setMode({ kind: "home" }), []);

  const leaveSetupToDraft = useCallback(() => {
    draftAfterHome.current = true;
    replaceRoute({ section: "home" });
    setMode({ kind: "home" });
  }, []);

  const openProtect = useCallback(() => setMode({ kind: "protect" }), []);
  const closeProtect = useCallback(() => setMode({ kind: "home" }), []);

  const rememberChoice = useCallback(
    (choice: { encrypt: boolean; method: UnlockMethod }) => {
      setStatus((previous) =>
        previous ? { ...previous, ...choice } : previous
      );
      saveOnboarding({ ...choice, step: "protect" }).catch(() => undefined);
    },
    []
  );

  const recordReminderShown = useCallback(async () => {
    await markReminderShown();
    setStatus((previous) =>
      previous
        ? {
            ...previous,
            reminderLastAtMs: Date.now(),
            reminderShownThisLaunch: true,
            remindersShown: previous.remindersShown + 1,
          }
        : previous
    );
  }, []);

  const stopReminders = useCallback(async () => {
    await turnRemindersOff();
    setStatus((previous) =>
      previous ? { ...previous, remindersOff: true } : previous
    );
  }, []);

  const actions = useMemo<OnboardingActions>(
    () => ({
      closeProtect,
      finishSetup,
      goTo,
      leaveSetup,
      leaveSetupToDraft,
      openProtect,
      recordReminderShown,
      rememberChoice,
      skipSetup,
      stopReminders,
    }),
    [
      closeProtect,
      finishSetup,
      goTo,
      leaveSetup,
      leaveSetupToDraft,
      openProtect,
      recordReminderShown,
      rememberChoice,
      skipSetup,
      stopReminders,
    ]
  );
  const value = useMemo<OnboardingContextValue>(
    () => ({ actions, state: { mode, status } }),
    [actions, mode, status]
  );

  return <OnboardingContext value={value}>{children}</OnboardingContext>;
}

/** Read where setup stands and decide what the window shows first. */
async function readLaunch(): Promise<{
  mode: OnboardingMode;
  status: OnboardingStatus | null;
}> {
  const ready = (await waitForNativeBridge()) && hasNativeBridge();
  if (!ready) {
    return { mode: { kind: "home" }, status: null };
  }
  const next = await getOnboardingStatus();
  const screen = launchScreen(next);
  if (screen.kind === "home") {
    return { mode: { kind: "home" }, status: next };
  }
  // Setup starts here for a new person. Saving it now means an import in setup
  // is never mistaken for an existing user's journal.
  let current = next;
  if (next.state === null) {
    await saveOnboarding({ state: "active", step: "welcome" }).catch(
      () => undefined
    );
    current = { ...next, state: "active" };
  }
  return { mode: { kind: "setup", step: screen.step }, status: current };
}
