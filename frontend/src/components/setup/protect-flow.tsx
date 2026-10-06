import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  enableEncryption,
  getLockStatus,
  type OnboardingStatus,
  requestRecoveryKey,
  saveRecoveryKey,
  setLockIdleTimeout,
  setLockPassword,
  setTouchIdEnabled,
  type UnlockMethod,
} from "@/bridge";
import { useLock } from "@/components/lock-provider";
import {
  ChooseScreen,
  ConfirmScreen,
  EncryptScreen,
  KeyScreen,
  PasswordScreen,
  TouchIdScreen,
} from "@/components/setup/protect-screens";
import { SetupBody, SetupFrame } from "@/components/setup/setup-frame";
import { Spinner } from "@/components/ui/spinner";
import { lockErrorMessage, minPasswordLength } from "@/lib/lock-errors";
import {
  defaultUnlockMethod,
  protectScreen,
  setupProtectScreen,
  touchIdChoiceAvailable,
  touchIdReady,
} from "@/lib/onboarding";
import { recoveryKeysMatch } from "@/lib/recovery-key";

/** What proves the owner is here when encryption turns on at the last step. */
type Proof = { kind: "password"; password: string } | { kind: "touch_id" };

type Stage =
  | { kind: "choose" }
  | { kind: "confirm"; proof: Proof; recoveryKey: string }
  | { encrypt: boolean; kind: "password" }
  | { encrypt: boolean; kind: "touch_id" }
  /** The lock is on and encryption is off: prove it is you, then get a key. */
  | { kind: "encrypt" }
  | { kind: "key"; proof: Proof; recoveryKey: string };

export interface ProtectResult {
  encrypted: boolean;
}

/**
 * The Protect screens: choose how to unlock, turn it on, and optionally encrypt
 * with a recovery key. First-launch setup and the reminder's Set up now both
 * run it. Every change goes through the calls Settings > Security uses: this
 * file sets no password, wraps no key, and touches no Keychain item itself.
 *
 * Encryption turns on only at the last screen, after the person types the key
 * back, so leaving earlier never strands an encrypted journal with no key. The
 * core makes the recovery key. The page shows it and sends back what was typed.
 *
 * Children is the header, so each caller picks the header that fits.
 */
export function ProtectFlow({
  children,
  onBack,
  onChoose,
  onDone,
  onSkip,
  saved,
}: {
  children: ReactNode;
  /** Shown on the first screen when the caller can go back. */
  onBack?: () => void;
  /** Called with the choice when the person continues from the first screen. */
  onChoose?: (choice: { encrypt: boolean; method: UnlockMethod }) => void;
  onDone: (result: ProtectResult) => void;
  /** Shown as Set up later when the caller can skip. */
  onSkip?: () => void;
  /** Setup passes what it saved, so a no to encryption is remembered. */
  saved?: Pick<OnboardingStatus, "encrypt" | "method">;
}) {
  const {
    actions: { refresh },
    state: { status: lock },
  } = useLock();
  const screen = lockScreenFor(lock, saved);
  const [stage, setStage] = useState<Stage>(() =>
    screen === "encrypt" ? { kind: "encrypt" } : { kind: "choose" }
  );
  const [method, setMethod] = useState<UnlockMethod>(
    saved?.method ?? defaultUnlockMethod(lock ?? { touchIdHardware: false })
  );
  const [encrypt, setEncrypt] = useState(saved?.method ? saved.encrypt : true);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState(
    lock?.idleTimeoutMs ?? 300_000
  );
  // With the lock already on, turning on encryption is all this flow does.
  const [lockWasOn] = useState(() => lock?.enabled ?? false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing left to ask when the lock and encryption are already on, or the
  // person already chose not to encrypt.
  const inQuestion = stage.kind === "choose" || stage.kind === "encrypt";
  const skipped = useRef(false as boolean);
  useEffect(() => {
    if (screen === "done" && inQuestion && !skipped.current) {
      skipped.current = true;
      onDone({ encrypted: lock?.encrypted ?? false });
    }
  }, [inQuestion, lock?.encrypted, onDone, screen]);

  const go = useCallback((next: Stage) => {
    setError(null);
    setStage(next);
  }, []);

  const handleChooseContinue = useCallback(() => {
    onChoose?.({ encrypt, method });
    go({ encrypt, kind: method });
  }, [encrypt, go, method, onChoose]);

  const handleBackToChoice = useCallback(() => {
    setPassword("");
    setConfirm("");
    go({ kind: "choose" });
  }, [go]);

  /** Run one change, show its failure on the current screen, and always stop. */
  const run = useCallback(
    async (change: () => Promise<void>, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        await change();
      } catch (caught: unknown) {
        setError(lockErrorMessage(caught, fallback));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const applyIdleTimeout = useCallback(async () => {
    if (lock && idleTimeoutMs !== lock.idleTimeoutMs) {
      await setLockIdleTimeout(idleTimeoutMs);
    }
  }, [idleTimeoutMs, lock]);

  const handleUseTouchId = useCallback(
    () =>
      run(async () => {
        if (!lock?.touchIdEnabled) {
          await setTouchIdEnabled(true);
        }
        await applyIdleTimeout();
        await refresh();
        if (!(stage.kind === "touch_id" && stage.encrypt)) {
          onDone({ encrypted: false });
          return;
        }
        // The key request owes a fresh Touch ID prompt, so this is the one
        // time macOS asks the person to touch the sensor.
        const recoveryKey = await requestRecoveryKey(null);
        go({ kind: "key", proof: { kind: "touch_id" }, recoveryKey });
      }, "Could not turn on Touch ID."),
    [applyIdleTimeout, go, lock?.touchIdEnabled, onDone, refresh, run, stage]
  );

  const handlePasswordSubmit = useCallback(() => {
    if (password.length < minPasswordLength) {
      setError(`Use at least ${minPasswordLength} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    return run(async () => {
      // A retry after a failed key request finds the password already set.
      if (!lock?.passwordSet) {
        await setLockPassword({ current: null, next: password });
      }
      await applyIdleTimeout();
      await refresh();
      if (!(stage.kind === "password" && stage.encrypt)) {
        onDone({ encrypted: false });
        return;
      }
      const recoveryKey = await requestRecoveryKey(password);
      go({ kind: "key", proof: { kind: "password", password }, recoveryKey });
    }, "Could not set the password.");
  }, [
    applyIdleTimeout,
    confirm,
    go,
    lock?.passwordSet,
    onDone,
    password,
    refresh,
    run,
    stage,
  ]);

  const handleEncryptSubmit = useCallback(() => {
    const withPassword = Boolean(lock?.passwordSet);
    return run(async () => {
      const recoveryKey = await requestRecoveryKey(
        withPassword ? password : null
      );
      go({
        kind: "key",
        proof: withPassword
          ? { kind: "password", password }
          : { kind: "touch_id" },
        recoveryKey,
      });
    }, "Could not make a recovery key.");
  }, [go, lock?.passwordSet, password, run]);

  const handleSubmitConfirm = useCallback(() => {
    if (stage.kind !== "confirm") {
      return;
    }
    const { proof, recoveryKey } = stage;
    if (!recoveryKeysMatch(recoveryKey, typed)) {
      setError("That doesn't match. Check it against the key you saved.");
      return;
    }
    return run(async () => {
      try {
        if (proof.kind === "password") {
          // The password turns encryption on and the recovery key backs it
          // up. A retry after the first half finds encryption already on.
          const current = await getLockStatus();
          if (!current.encrypted) {
            await enableEncryption({ password: proof.password });
          }
          await saveRecoveryKey(recoveryKey);
        } else {
          await enableEncryption({ recoveryKey });
        }
      } finally {
        // A rewrite or a file rebuild shows the securing screen from here.
        await refresh().catch(() => undefined);
      }
      onDone({ encrypted: true });
    }, "Could not turn on encryption.");
  }, [onDone, refresh, run, stage, typed]);

  const handleKeySaved = useCallback(() => {
    if (stage.kind === "key") {
      setTyped("");
      go({
        kind: "confirm",
        proof: stage.proof,
        recoveryKey: stage.recoveryKey,
      });
    }
  }, [go, stage]);

  const handleBackToKey = useCallback(() => {
    if (stage.kind === "confirm") {
      go({ kind: "key", proof: stage.proof, recoveryKey: stage.recoveryKey });
    }
  }, [go, stage]);

  // The key screen can only go back to asking for proof: the lock is already
  // on, and the old key stays hidden.
  const handleBackToEncrypt = useCallback(() => go({ kind: "encrypt" }), [go]);

  let content: ReactNode;
  if (lock === null) {
    content = <Spinner />;
  } else if (stage.kind === "choose") {
    content = (
      <ChooseScreen
        encrypt={encrypt}
        method={touchIdChoiceAvailable(lock) ? method : "password"}
        onBack={onBack}
        onContinue={handleChooseContinue}
        onEncryptChange={setEncrypt}
        onMethodChange={setMethod}
        onSkip={onSkip}
        touchIdAvailable={touchIdChoiceAvailable(lock)}
        touchIdReady={touchIdReady(lock)}
      />
    );
  } else if (stage.kind === "touch_id") {
    content = (
      <TouchIdScreen
        busy={busy}
        encrypt={stage.encrypt}
        error={error}
        idleTimeoutMs={idleTimeoutMs}
        onBack={handleBackToChoice}
        onIdleChange={setIdleTimeoutMs}
        onUse={handleUseTouchId}
      />
    );
  } else if (stage.kind === "password") {
    content = (
      <PasswordScreen
        busy={busy}
        confirm={confirm}
        encrypt={stage.encrypt}
        error={error}
        idleTimeoutMs={idleTimeoutMs}
        onBack={handleBackToChoice}
        onConfirmChange={setConfirm}
        onIdleChange={setIdleTimeoutMs}
        onPasswordChange={setPassword}
        onSubmit={handlePasswordSubmit}
        password={password}
      />
    );
  } else if (stage.kind === "encrypt") {
    content = (
      <EncryptScreen
        busy={busy}
        error={error}
        needsPassword={lock.passwordSet}
        onBack={onBack}
        onPasswordChange={setPassword}
        onSkip={onSkip}
        onSubmit={handleEncryptSubmit}
        password={password}
      />
    );
  } else if (stage.kind === "key") {
    content = (
      <KeyScreen
        onBack={handleBackToEncrypt}
        onSaved={handleKeySaved}
        recoveryKey={stage.recoveryKey}
      />
    );
  } else {
    content = (
      <ConfirmScreen
        busy={busy}
        confirmLabel={
          lockWasOn ? "Turn on encryption" : "Turn on lock and encryption"
        }
        error={error}
        onBack={handleBackToKey}
        onSubmit={handleSubmitConfirm}
        onTypedChange={setTyped}
        typed={typed}
      />
    );
  }

  return (
    <SetupFrame>
      {children}
      <SetupBody>{content}</SetupBody>
    </SetupFrame>
  );
}

function lockScreenFor(
  lock: ReturnType<typeof useLock>["state"]["status"],
  saved: Pick<OnboardingStatus, "encrypt" | "method"> | undefined
) {
  if (lock === null) {
    return "choose";
  }
  return saved ? setupProtectScreen(lock, saved) : protectScreen(lock);
}
