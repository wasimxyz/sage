import { FingerprintIcon, LeafIcon } from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

import { startWindowDrag } from "@/bridge";
import { useLock } from "@/components/lock-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";
import { recoveryUnlockMessage } from "@/lib/lock-errors";
import { waitSecondsFromMs } from "@/lib/lock-wait";
import { normalizeRecoveryKey } from "@/lib/recovery-key";

export function LockScreen() {
  const {
    actions: { refresh, tryPassword, tryTouchId },
    state: { status, statusError, touchIdError },
  } = useLock();
  const fullscreen = useWindowFullscreen();
  const [password, setPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [touchIdBusy, setTouchIdBusy] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [passwordFailed, setPasswordFailed] = useState(false);
  const [statusRetryBusy, setStatusRetryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);

  // The wait belongs to Zig and outlives the page, so read how much of it is
  // left whenever the status is read: after a failed guess, and after a reload
  // that mounts this screen again.
  useEffect(() => {
    setWaitSeconds(waitSecondsFromMs(status?.waitRemainingMs ?? 0));
  }, [status]);

  // Zig refuses a guess inside its own wait, so this only keeps the button
  // honest while a retry would be turned away.
  useEffect(() => {
    if (waitSeconds <= 0) {
      return;
    }
    const timer = setTimeout(() => setWaitSeconds(waitSeconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [waitSeconds]);

  const runTouchId = useCallback(
    async (showError: boolean) => {
      setTouchIdBusy(true);
      if (showError) {
        setError(null);
      }
      const failure = await tryTouchId();
      setTouchIdBusy(false);
      if (showError) {
        setError(failure);
      }
    },
    [tryTouchId]
  );

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (passwordBusy || waitSeconds > 0 || password.length === 0) {
        return;
      }
      setPasswordBusy(true);
      setError(null);
      try {
        await waitForPaintedFrame();
        const outcome = await tryPassword(password);
        if (outcome.unlocked) {
          return;
        }
        setPasswordFailed(true);
        setPassword("");
        if (outcome.tooManyAttempts) {
          setError(null);
        } else {
          setError("Wrong password.");
        }
      } catch {
        // LockProvider keeps the lock screen mounted if status cannot be read.
      } finally {
        setPasswordBusy(false);
      }
    },
    [password, passwordBusy, waitSeconds, tryPassword]
  );

  const handleShowRecovery = useCallback(() => {
    setError(null);
    setRecoveryMode(true);
  }, []);

  const handleHideRecovery = useCallback(() => {
    setError(null);
    setRecoveryMode(false);
  }, []);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPassword(event.target.value);
    },
    []
  );

  const handleTouchIdClick = useCallback(() => {
    runTouchId(true);
  }, [runTouchId]);

  const retryLockStatus = useCallback(async () => {
    setStatusRetryBusy(true);
    setError(null);
    try {
      await refresh();
    } catch {
      // refresh keeps the status error visible and the journal unmounted.
    } finally {
      setStatusRetryBusy(false);
    }
  }, [refresh]);

  // The recovery key is for a journal whose Keychain copy is lost or whose
  // password is forgotten, so it only shows when one was saved. The button
  // waits for a failed attempt: a wrong password, a Touch ID that did not
  // open the journal, or a wrong-guess wait left over from before a reload.
  const canUseRecoveryKey = Boolean(status?.encrypted && status.recoveryKeySet);
  const failedAttempt =
    passwordFailed || touchIdError !== null || waitSeconds > 0;
  const showRecovery = recoveryMode && canUseRecoveryKey;

  const message = lockScreenMessage(
    statusError,
    waitSeconds,
    error,
    showRecovery ? null : touchIdError
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      style={
        {
          "--titlebar-leading": fullscreen ? "0.5rem" : "5.375rem",
        } as CSSProperties
      }
    >
      <header
        className="flex h-(--titlebar-height) shrink-0 flex-col"
        data-slot="window-titlebar"
        onPointerDown={onTitlebarPointerDown}
      >
        <div className="flex h-(--titlebar-height) shrink-0 items-center pl-[calc(var(--titlebar-leading)+0.5rem)]" />
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
        <div className="flex w-full max-w-2xs flex-col items-center gap-4 text-center">
          <LeafIcon className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h1 className="font-medium text-lg">Sage is locked</h1>
            <p className="text-balance text-muted-foreground text-sm">
              Unlock Sage to read and write entries.
            </p>
          </div>
          {showRecovery ? (
            <RecoveryKeyForm
              onBack={handleHideRecovery}
              onError={setError}
              waitSeconds={waitSeconds}
            />
          ) : null}
          {!showRecovery && status?.passwordSet ? (
            <form className="flex w-full flex-col gap-2" onSubmit={submit}>
              <Input
                aria-label="Password"
                autoFocus
                disabled={passwordBusy || waitSeconds > 0}
                onChange={handlePasswordChange}
                placeholder="Password"
                type="password"
                value={password}
              />
              <Button
                disabled={
                  passwordBusy || waitSeconds > 0 || password.length === 0
                }
                type="submit"
              >
                {passwordBusy ? <Spinner data-icon="inline-start" /> : null}
                {passwordBusy ? "Unlocking..." : "Unlock"}
              </Button>
            </form>
          ) : null}
          {!showRecovery && status?.touchIdEnabled ? (
            <TouchIdButton
              biometrics={status.touchIdBiometrics}
              busy={touchIdBusy}
              onClick={handleTouchIdClick}
            />
          ) : null}
          {!showRecovery && canUseRecoveryKey && failedAttempt ? (
            <Button
              className="-mt-2 w-full"
              onClick={handleShowRecovery}
              type="button"
              variant="ghost"
            >
              Use recovery key
            </Button>
          ) : null}
          {statusError ? (
            <LockStatusError
              busy={statusRetryBusy}
              message={statusError}
              onRetry={retryLockStatus}
            />
          ) : null}
          {message ? (
            <p className="text-destructive text-sm" role="alert">
              {message}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function TouchIdButton({
  biometrics,
  busy,
  onClick,
}: {
  biometrics: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      className="w-full"
      disabled={busy}
      onClick={onClick}
      variant="outline"
    >
      {busy ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <FingerprintIcon data-icon="inline-start" />
      )}
      {biometrics ? "Use Touch ID" : "Use Mac login password"}
    </Button>
  );
}

// For a journal whose Keychain copy is lost or whose password is forgotten.
// The recovery key shares the password's wrong-guess wait, so `waitSeconds`
// disables this form the same way.
function RecoveryKeyForm({
  onBack,
  onError,
  waitSeconds,
}: {
  onBack: () => void;
  onError: (message: string | null) => void;
  waitSeconds: number;
}) {
  const {
    actions: { tryRecoveryKey },
  } = useLock();
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = normalizeRecoveryKey(recoveryKey) !== null;

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(event.target.value);
  }, []);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy || waitSeconds > 0 || !valid) {
        return;
      }
      setBusy(true);
      onError(null);
      try {
        await waitForPaintedFrame();
        const outcome = await tryRecoveryKey(recoveryKey);
        if (outcome.unlocked) {
          return;
        }
        setRecoveryKey("");
        onError(
          outcome.tooManyAttempts ? null : recoveryUnlockMessage(outcome.error)
        );
      } catch {
        // LockProvider keeps the lock screen mounted if status cannot be read.
      } finally {
        setBusy(false);
      }
    },
    [busy, onError, recoveryKey, tryRecoveryKey, valid, waitSeconds]
  );

  return (
    <form className="flex w-full flex-col gap-2" onSubmit={submit}>
      <Input
        aria-label="Recovery key"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        autoFocus
        className="font-mono tracking-wider"
        disabled={busy || waitSeconds > 0}
        onChange={handleChange}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        spellCheck={false}
        value={recoveryKey}
      />
      <Button disabled={busy || waitSeconds > 0 || !valid} type="submit">
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {busy ? "Unlocking..." : "Unlock"}
      </Button>
      <Button disabled={busy} onClick={onBack} type="button" variant="ghost">
        Back
      </Button>
    </form>
  );
}

function LockStatusError({
  busy,
  message,
  onRetry,
}: {
  busy: boolean;
  message: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-destructive text-sm" role="alert">
        {message}
      </p>
      <Button disabled={busy} onClick={onRetry} variant="outline">
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {busy ? "Checking..." : "Retry"}
      </Button>
    </div>
  );
}

function lockScreenMessage(
  statusError: string | null,
  waitSeconds: number,
  error: string | null,
  touchIdError: string | null
): string | null {
  if (statusError !== null) {
    return null;
  }
  if (waitSeconds > 0) {
    return waitMessage(waitSeconds);
  }
  return error ?? touchIdError;
}

// Let the browser paint the busy label before starting the native unlock.
function waitForPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

// `retry_wait_ms` in `src/lock.zig` is the wait Zig enforces; the screen only
// reports the seconds that are left.
function waitMessage(seconds: number): string {
  const unit = seconds === 1 ? "second" : "seconds";
  return `Too many attempts. Try again in ${seconds} ${unit}.`;
}

function onTitlebarPointerDown(event: PointerEvent<HTMLElement>) {
  if (event.button !== 0) {
    return;
  }
  const { target } = event;
  if (!(target instanceof Element)) {
    return;
  }
  if (
    target.closest(
      "button, a, input, textarea, [role='button'], [data-slot='toggle']"
    )
  ) {
    return;
  }
  startWindowDrag();
}
