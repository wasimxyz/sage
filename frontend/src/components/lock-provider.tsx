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
import { toast } from "sonner";

import {
  getLockStatus,
  hasNativeBridge,
  type LockStatus,
  onLockChanged,
  onLockUnavailable,
  runEncryptionScrub,
  unlockWithPassword,
  unlockWithRecoveryKey,
  unlockWithTouchId,
  waitForNativeBridge,
} from "@/bridge";
import { LockScreen } from "@/components/lock-screen";
import { RecoveryKeyRotationPrompt } from "@/components/recovery-key-rotation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { handlerErrorMessage, isTooManyAttempts } from "@/lib/handler-errors";
import {
  claimLaunchTouchIdPrompt,
  type LaunchTouchIdPromptState,
} from "@/lib/launch-touch-id";
import { shouldKeepLockScreen } from "@/lib/lock-state";
import { normalizeRecoveryKey } from "@/lib/recovery-key";

export interface LockState {
  status: LockStatus | null;
  statusError: string | null;
  touchIdError: string | null;
}

/**
 * What one password or recovery key unlock came back as. `tooManyAttempts`
 * means the native side refused the guess without checking it, because too
 * many guesses failed a moment ago. `error` is what the native side said.
 */
export type UnlockOutcome =
  | { tooManyAttempts: false; unlocked: true }
  | { error: unknown; tooManyAttempts: boolean; unlocked: false };

export interface LockActions {
  refresh: () => Promise<void>;
  tryPassword: (password: string) => Promise<UnlockOutcome>;
  tryRecoveryKey: (recoveryKey: string) => Promise<UnlockOutcome>;
  tryTouchId: () => Promise<string | null>;
}

interface LockContextValue {
  actions: LockActions;
  state: LockState;
}

const LockContext = createContext<LockContextValue | null>(null);

const unlockedFallback: LockStatus = {
  enabled: false,
  encrypted: false,
  fileVault: "unknown",
  idleTimeoutMs: 300_000,
  passwordSet: false,
  recoveredSession: false,
  recoveryKeyRotate: false,
  recoveryKeySet: false,
  scrubbing: false,
  securing: false,
  touchIdAvailable: false,
  touchIdBiometrics: false,
  touchIdEnabled: false,
  touchIdHardware: false,
  unlocked: true,
  waitRemainingMs: 0,
};

export function useLock(): LockContextValue {
  const value = use(LockContext);
  if (!value) {
    throw new Error("LockProvider is missing.");
  }
  return value;
}

/**
 * Decides whether the journal may mount. While the lock is engaged the
 * children — JournalProvider included — never render, so journal.list cannot
 * run and no titles or bodies reach the page. The Zig side refuses those
 * commands too. A file rebuild that can run without the data key is the
 * same kind of gate. A pending row rewrite waits for unlock first; the Zig
 * side refuses journal, chat, embeddings, Dream, and agent jobs until
 * both steps finish.
 */
export function LockProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [touchIdError, setTouchIdError] = useState<string | null>(null);
  const launchTouchIdPrompt = useRef<LaunchTouchIdPromptState>({
    checked: false,
    eligible: false,
    prompted: false,
  });
  const [scrubError, setScrubError] = useState<string | null>(null);
  const [scrubBusy, setScrubBusy] = useState(false);

  const refresh = useCallback(async (allowBrowserFallback = false) => {
    const ready = (await waitForNativeBridge()) && hasNativeBridge();
    if (!ready) {
      if (allowBrowserFallback) {
        // Browser dev has no bridge; behave as if the lock were off and let
        // the journal surface its own "needs the desktop app" error.
        setStatus(unlockedFallback);
        setStatusError(null);
      } else {
        setStatus(null);
        setStatusError("Could not check lock status. Sage stays locked.");
      }
      setTouchIdError(null);
      return;
    }
    try {
      const nextStatus = await getLockStatus();
      setStatus(nextStatus);
      setStatusError(null);
      setTouchIdError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(
        handlerErrorMessage(error) ||
          "Could not check lock status. Sage stays locked."
      );
      throw error;
    }
  }, []);

  useEffect(() => {
    refresh(true).catch(() => undefined);
  }, [refresh]);

  useEffect(
    () => onLockChanged(() => refresh().catch(() => undefined)),
    [refresh]
  );

  useEffect(
    () =>
      onLockUnavailable(() => {
        toast.info("Turn on the lock in Settings > Security to use Lock.");
      }),
    []
  );

  const runScrub = useCallback(async () => {
    setScrubError(null);
    setScrubBusy(true);
    try {
      await runEncryptionScrub();
      await refresh();
    } catch {
      setScrubError("Sage could not finish securing your journal.");
    } finally {
      setScrubBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    const canRun =
      Boolean(status?.scrubbing) ||
      Boolean(status?.securing && status.unlocked);
    if (!canRun) {
      return;
    }
    runScrub().catch(() => undefined);
  }, [status?.scrubbing, status?.securing, status?.unlocked, runScrub]);

  const tryPassword = useCallback(
    async (password: string): Promise<UnlockOutcome> => {
      try {
        await unlockWithPassword(password);
        await refresh();
        return { tooManyAttempts: false, unlocked: true };
      } catch (error) {
        // A refused guess can start the wait or move it forward, so read the
        // new status before the screen decides what to show.
        await refresh();
        return {
          error,
          tooManyAttempts: isTooManyAttempts(error),
          unlocked: false,
        };
      }
    },
    [refresh]
  );

  // The recovery key shares the password's wrong-guess wait, so a refused
  // guess reads the same way here. Sage compares the key without dashes or
  // spaces, so that is what it gets: pasted text cannot overrun the request.
  const tryRecoveryKey = useCallback(
    async (recoveryKey: string): Promise<UnlockOutcome> => {
      const normalized = normalizeRecoveryKey(recoveryKey);
      if (normalized === null) {
        return {
          error: new Error("InvalidRecoveryKey"),
          tooManyAttempts: false,
          unlocked: false,
        };
      }
      try {
        const { touchIdKeyMissing } = await unlockWithRecoveryKey(normalized);
        if (touchIdKeyMissing) {
          toast.warning(
            "Sage could not save the key for Touch ID, so Touch ID will not open your journal next time. Unlock with your recovery key again to retry."
          );
        }
        await refresh();
        return { tooManyAttempts: false, unlocked: true };
      } catch (error) {
        await refresh();
        return {
          error,
          tooManyAttempts: isTooManyAttempts(error),
          unlocked: false,
        };
      }
    },
    [refresh]
  );

  const tryTouchId = useCallback(async (): Promise<string | null> => {
    setTouchIdError(null);
    try {
      await unlockWithTouchId();
      await refresh();
      return null;
    } catch (error) {
      const message =
        handlerErrorMessage(error) || "Touch ID was not completed.";
      setTouchIdError(message);
      return message;
    }
  }, [refresh]);

  useEffect(() => {
    if (
      status &&
      claimLaunchTouchIdPrompt(launchTouchIdPrompt.current, status)
    ) {
      tryTouchId().catch(() => undefined);
    }
  }, [status, tryTouchId]);

  const actions = useMemo<LockActions>(
    () => ({ refresh, tryPassword, tryRecoveryKey, tryTouchId }),
    [refresh, tryPassword, tryRecoveryKey, tryTouchId]
  );
  const value = useMemo<LockContextValue>(
    () => ({ actions, state: { status, statusError, touchIdError } }),
    [actions, status, statusError, touchIdError]
  );

  const locked = shouldKeepLockScreen(status, statusError);

  let content: ReactNode;
  if (status === null && !locked) {
    content = (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
        <Spinner />
      </div>
    );
  } else if (status?.scrubbing) {
    content = (
      <ScrubScreen busy={scrubBusy} error={scrubError} onRetry={runScrub} />
    );
  } else if (locked) {
    content = <LockScreen />;
  } else if (status?.securing) {
    content = (
      <ScrubScreen busy={scrubBusy} error={scrubError} onRetry={runScrub} />
    );
  } else {
    content = (
      <>
        {children}
        {status?.recoveryKeyRotate ? (
          <RecoveryKeyRotationPrompt refresh={refresh} status={status} />
        ) : null}
      </>
    );
  }

  return <LockContext value={value}>{content}</LockContext>;
}

function ScrubScreen({
  busy,
  error,
  onRetry,
}: {
  busy: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        {busy || !error ? <Spinner /> : null}
        <div className="flex flex-col gap-1">
          <h1 className="font-medium text-lg">Securing your journal</h1>
          <p className="text-balance text-muted-foreground text-sm">
            Sage is rebuilding its database so old data can&apos;t be recovered.
            This only takes a moment.
          </p>
        </div>
        {error ? (
          <>
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
            <Button disabled={busy} onClick={onRetry} variant="outline">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Retry
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
