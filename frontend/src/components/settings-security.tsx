import { LockIcon } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { toast } from "sonner";

import {
  disableEncryption,
  disableLock,
  enableEncryption,
  type LockStatus,
  removeLockPassword,
  requestRecoveryKey,
  saveRecoveryKey,
  setLockIdleTimeout,
  setLockPassword,
  setTouchIdEnabled,
} from "@/bridge";
import { IdleTimeoutSelect } from "@/components/idle-timeout-select";
import { useLock } from "@/components/lock-provider";
import { RecoveryKeyDialog } from "@/components/recovery-key-dialog";
import { SettingsRow } from "@/components/settings-row";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  lastUnlockMethodMessage,
  lockErrorMessage,
  minPasswordLength,
  removeEncryptionFirst,
} from "@/lib/lock-errors";

const encryptedOnDisk =
  "Titles, bodies, summaries, embedding text, chat transcripts, dreamed memories, and Chat instructions are encrypted on disk.";
const encryptedOffDisk =
  "Titles, bodies, summaries, embedding text, chat transcripts, dreamed memories, and Chat instructions are not encrypted.";
const fileVaultOffMessage =
  "FileVault is off. Without it, your Mac password is the only thing protecting the journal key. Turn it on in System Settings > Privacy & Security.";

export function SecuritySettings() {
  const {
    actions: { refresh },
    state: { status },
  } = useLock();

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return (
    <SettingsSection
      description="Lock Sage and encrypt your journal."
      title="Security"
    >
      {status ? <SecurityBody refresh={refresh} status={status} /> : null}
    </SettingsSection>
  );
}

function SecurityBody({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  return (
    <>
      {status.enabled ? (
        <LockOnStatus
          encrypted={status.encrypted}
          passwordSet={status.passwordSet}
          refresh={refresh}
        />
      ) : (
        <LockOffStatus touchIdAvailable={status.touchIdAvailable} />
      )}
      <div className="mt-2 flex flex-col divide-y">
        {status.enabled ? (
          <IdleTimeoutGroup refresh={refresh} status={status} />
        ) : null}
        <PasswordGroup refresh={refresh} status={status} />
        {status.touchIdAvailable ? (
          <TouchIdGroup refresh={refresh} status={status} />
        ) : null}
        <EncryptionGroup refresh={refresh} status={status} />
      </div>
      {status.encrypted &&
      !status.passwordSet &&
      status.touchIdEnabled &&
      status.fileVault === "off" ? (
        <p className="mt-3 text-muted-foreground text-sm">
          {fileVaultOffMessage}
        </p>
      ) : null}
    </>
  );
}

function LockOffStatus({ touchIdAvailable }: { touchIdAvailable: boolean }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2 text-foreground">
        <LockIcon className="size-4" />
        <p className="text-sm">Lock is off</p>
      </div>
      <p className="text-foreground text-sm">
        {touchIdAvailable
          ? "Set a password or turn on Touch ID."
          : "Set a password."}
      </p>
    </div>
  );
}

function IdleTimeoutGroup({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [busy, setBusy] = useState(false);

  const handleValueChange = useCallback(
    (idleTimeoutMs: number) => {
      if (busy || idleTimeoutMs === status.idleTimeoutMs) {
        return;
      }
      setBusy(true);
      setLockIdleTimeout(idleTimeoutMs)
        .then(() => refresh())
        .catch(() => {
          toast.error("Sage could not save the idle timeout.");
        })
        .finally(() => setBusy(false));
    },
    [busy, refresh, status.idleTimeoutMs]
  );

  return (
    <SettingsRow
      description="Sage locks when its window receives no input. Using another app still counts as idle."
      title="Lock after inactivity"
    >
      <IdleTimeoutSelect
        disabled={busy}
        label="Lock after inactivity"
        onChange={handleValueChange}
        value={status.idleTimeoutMs}
      />
    </SettingsRow>
  );
}

function LockOnStatus({
  encrypted,
  passwordSet,
  refresh,
}: {
  encrypted: boolean;
  passwordSet: boolean;
  refresh: () => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!encrypted) {
      setBlocked(false);
    }
  }, [encrypted]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setDialogOpen(nextOpen);
    if (!nextOpen) {
      setPassword("");
      setError(null);
    }
  }, []);

  const handleTurnOffClick = useCallback(() => {
    if (encrypted) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setDialogOpen(true);
  }, [encrypted]);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );

  const handleConfirm = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    disableLock(passwordSet ? password : null)
      .then(async () => {
        toast.success("Lock turned off.");
        setDialogOpen(false);
        setPassword("");
        await refresh();
      })
      .catch((disableError: unknown) => {
        setError(
          lockErrorMessage(disableError, "Could not turn off the lock.")
        );
      })
      .finally(() => setBusy(false));
  }, [busy, password, passwordSet, refresh]);

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-surface px-3 py-2.5">
        <div className="flex items-center gap-2 text-foreground">
          <LockIcon className="size-4" />
          <p className="text-sm">Lock is on</p>
        </div>
        <Button onClick={handleTurnOffClick} size="sm" variant="outline">
          Turn off
        </Button>
      </div>
      {encrypted ? null : (
        <p className="mt-2 text-muted-foreground text-sm">
          With encryption off, the lock only stops Sage until you unlock it. The
          SQLite file is still readable.
        </p>
      )}
      {blocked ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {removeEncryptionFirst}
        </p>
      ) : null}
      <Dialog onOpenChange={handleOpenChange} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off the lock?</DialogTitle>
            <DialogDescription>
              Sage opens straight to your journal. Anyone at this Mac can read
              every page.
            </DialogDescription>
          </DialogHeader>
          {passwordSet ? (
            <Field>
              <FieldLabel htmlFor="settings-disable-password">
                Current password
              </FieldLabel>
              <Input
                autoComplete="current-password"
                disabled={busy}
                id="settings-disable-password"
                onChange={handlePasswordChange}
                type="password"
                value={password}
              />
              <FieldError>{error}</FieldError>
            </Field>
          ) : null}
          <DialogActions>
            <DialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={busy || (passwordSet && password.length === 0)}
              onClick={handleConfirm}
              variant="destructive"
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Turn off lock
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PasswordGroup({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const { passwordSet } = status;
  // After an unlock with the recovery key the owner may have forgotten the
  // password, so Sage does not ask for it.
  const needsCurrent = passwordSet && !status.recoveredSession;
  const [expanded, setExpanded] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExpand = useCallback(() => {
    setExpanded(true);
    setError(null);
  }, []);

  const handleCancel = useCallback(() => {
    setExpanded(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  }, []);

  const handleCurrentChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setCurrent(event.target.value),
    []
  );
  const handleNextChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setNext(event.target.value),
    []
  );
  const handleConfirmChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setConfirm(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      if (next.length < minPasswordLength) {
        setError(`Use at least ${minPasswordLength} characters.`);
        return;
      }
      if (next !== confirm) {
        setError("Passwords don't match.");
        return;
      }
      setBusy(true);
      setError(null);
      setLockPassword({ current: needsCurrent ? current : null, next })
        .then(async () => {
          toast.success(passwordSet ? "Password changed." : "Password set.");
          setExpanded(false);
          setCurrent("");
          setNext("");
          setConfirm("");
          await refresh();
        })
        .catch((submitError: unknown) => {
          setError(
            lockErrorMessage(submitError, "Could not update the password.")
          );
        })
        .finally(() => setBusy(false));
    },
    [busy, confirm, current, needsCurrent, next, passwordSet, refresh]
  );

  let description = "No password set.";
  if (passwordSet) {
    description = "Sage asks for your password on every launch.";
  } else if (status.encrypted) {
    description =
      "No password set. Adding one asks you to confirm with Touch ID.";
  }

  return (
    <div>
      <SettingsRow description={description} title="Password">
        {expanded ? null : (
          <div className="flex items-center gap-2">
            {passwordSet && status.touchIdEnabled ? (
              <RemovePasswordControl refresh={refresh} status={status} />
            ) : null}
            <Button onClick={handleExpand} size="sm" variant="outline">
              {passwordSet ? "Change password" : "Set password"}
            </Button>
          </div>
        )}
      </SettingsRow>
      {expanded ? (
        <form
          className="mb-4 flex flex-col gap-3 rounded-lg border bg-surface p-4"
          onSubmit={handleSubmit}
        >
          {needsCurrent ? (
            <Field>
              <FieldLabel htmlFor="settings-current-password">
                Current password
              </FieldLabel>
              <Input
                autoComplete="current-password"
                disabled={busy}
                id="settings-current-password"
                onChange={handleCurrentChange}
                type="password"
                value={current}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="settings-new-password">
              {passwordSet ? "New password" : "Password"}
            </FieldLabel>
            <Input
              autoComplete="new-password"
              disabled={busy}
              id="settings-new-password"
              onChange={handleNextChange}
              type="password"
              value={next}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-confirm-password">
              Confirm password
            </FieldLabel>
            <Input
              autoComplete="new-password"
              disabled={busy}
              id="settings-confirm-password"
              onChange={handleConfirmChange}
              type="password"
              value={confirm}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              disabled={busy}
              onClick={handleCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={busy || next.length === 0 || (needsCurrent && !current)}
              size="sm"
              type="submit"
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Save password
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// Removing the password leaves Touch ID as the only way in. It costs the
// password, except after an unlock with the recovery key. An encrypted journal
// with no recovery key yet needs one first, in case Touch ID cannot open it.
function RemovePasswordControl({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An encrypted journal gets a new recovery key every time the password goes,
  // so the owner holds a key that works at the moment Touch ID becomes the
  // only other way in. An older key may be lost, and Sage cannot tell.
  const needsPassword = !status.recoveredSession;

  useEffect(() => {
    if (!open) {
      setPassword("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleOpenClick = useCallback(() => setOpen(true), []);
  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );

  const handleConfirm = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    removeLockPassword({
      password: needsPassword ? password : null,
      recoveryKey: null,
    })
      .then(async () => {
        toast.success("Password removed.");
        setOpen(false);
        await refresh();
      })
      .catch((removeError: unknown) => {
        setError(
          lockErrorMessage(removeError, "Could not remove the password.")
        );
      })
      .finally(() => setBusy(false));
  }, [busy, needsPassword, password, refresh]);

  const handleKeyConfirm = useCallback(
    async (recoveryKey: string, typedPassword: string | null) => {
      await removeLockPassword({ password: typedPassword, recoveryKey });
      toast.success("Password removed.");
      await refresh();
    },
    [refresh]
  );

  return (
    <>
      <Button onClick={handleOpenClick} size="sm" variant="outline">
        Remove password
      </Button>
      {status.encrypted ? (
        <RecoveryKeyDialog
          confirmLabel="Remove password"
          getKey={requestRecoveryKey}
          intro={
            status.recoveryKeySet
              ? "Sage will unlock with Touch ID only. First, make a new recovery key to save. The old key stops working once you do."
              : "Sage will unlock with Touch ID only. First, make a recovery key to save, in case Touch ID can no longer open your journal."
          }
          needsPassword={needsPassword}
          onConfirm={handleKeyConfirm}
          onOpenChange={setOpen}
          open={open}
          title="Remove your password?"
          touchIdOnly
        />
      ) : (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove your password?</DialogTitle>
              <DialogDescription>
                Sage will unlock with Touch ID only.
              </DialogDescription>
            </DialogHeader>
            {needsPassword ? (
              <Field>
                <FieldLabel htmlFor="settings-remove-password">
                  Current password
                </FieldLabel>
                <Input
                  autoComplete="current-password"
                  disabled={busy}
                  id="settings-remove-password"
                  onChange={handlePasswordChange}
                  type="password"
                  value={password}
                />
                <FieldError>{error}</FieldError>
              </Field>
            ) : (
              <FieldError>{error}</FieldError>
            )}
            <DialogActions>
              <DialogClose
                disabled={busy}
                render={<Button variant="outline" />}
              >
                Cancel
              </DialogClose>
              <Button
                disabled={busy || (needsPassword && password.length === 0)}
                onClick={handleConfirm}
                variant="destructive"
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Remove password
              </Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// Turning Touch ID off weakens the lock, so it costs proof: the Sage password
// when one is set, otherwise a fresh system prompt. Turning it on needs
// neither.
function TouchIdGroup({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status.passwordSet || !status.encrypted) {
      setBlocked(false);
    }
  }, [status.encrypted, status.passwordSet]);

  useEffect(() => {
    if (!status.touchIdEnabled) {
      setDialogOpen(false);
      setPassword("");
      setError(null);
    }
  }, [status.touchIdEnabled]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setDialogOpen(nextOpen);
    if (!nextOpen) {
      setPassword("");
      setError(null);
    }
  }, []);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );

  const handleTurnOn = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setTouchIdEnabled(true)
      .then(async () => {
        toast.success("Touch ID turned on.");
        await refresh();
      })
      .catch((turnOnError: unknown) => {
        toast.error(
          lockErrorMessage(turnOnError, "Could not update Touch ID.")
        );
      })
      .finally(() => setBusy(false));
  }, [busy, refresh]);

  const handleTurnOffClick = useCallback(() => {
    if (busy) {
      return;
    }
    if (status.encrypted && !status.passwordSet) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setDialogOpen(true);
  }, [busy, status.encrypted, status.passwordSet]);

  const handleConfirm = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    // With no password set, the promise settles when the system sheet does.
    setTouchIdEnabled(false, status.passwordSet ? password : null)
      .then(async () => {
        toast.success("Touch ID turned off.");
        setDialogOpen(false);
        setPassword("");
        await refresh();
      })
      .catch((turnOffError: unknown) => {
        const message = lockErrorMessage(
          turnOffError,
          "Could not update Touch ID."
        );
        if (status.passwordSet) {
          setError(message);
          return;
        }
        // The system sheet has no field to hang the message on.
        toast.error(message);
      })
      .finally(() => setBusy(false));
  }, [busy, password, refresh, status.passwordSet]);

  return (
    <div>
      <SettingsRow
        description={
          status.touchIdBiometrics
            ? "Unlock Sage with Touch ID."
            : "Unlock Sage with your Mac login password."
        }
        title={status.touchIdBiometrics ? "Touch ID" : "Mac login password"}
      >
        <Button
          disabled={busy}
          onClick={status.touchIdEnabled ? handleTurnOffClick : handleTurnOn}
          size="sm"
          variant="outline"
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {status.touchIdEnabled ? "Turn off" : "Turn on"}
        </Button>
      </SettingsRow>
      {blocked ? (
        <p className="-mt-2 pb-4 text-destructive text-sm" role="alert">
          {lastUnlockMethodMessage}
        </p>
      ) : null}
      <Dialog onOpenChange={handleOpenChange} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off Touch ID?</DialogTitle>
            <DialogDescription>
              {status.passwordSet
                ? "Sage still asks for your password on every launch."
                : "Sage opens straight to your journal. Anyone at this Mac can read every page."}
            </DialogDescription>
          </DialogHeader>
          {status.passwordSet ? (
            <Field>
              <FieldLabel htmlFor="settings-touch-id-password">
                Current password
              </FieldLabel>
              <Input
                autoComplete="current-password"
                disabled={busy}
                id="settings-touch-id-password"
                onChange={handlePasswordChange}
                type="password"
                value={password}
              />
              <FieldError>{error}</FieldError>
            </Field>
          ) : null}
          <DialogActions>
            <DialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={busy || (status.passwordSet && password.length === 0)}
              onClick={handleConfirm}
              variant="destructive"
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Turn off Touch ID
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EncryptionGroup({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  if (!(status.passwordSet || status.touchIdEnabled)) {
    return (
      <SettingsRow
        description="Turn on Touch ID or set a password to enable encryption."
        muted
        title="Encryption"
      >
        <Button disabled size="sm" variant="outline">
          Encrypt journal
        </Button>
      </SettingsRow>
    );
  }

  return (
    <>
      {status.passwordSet ? (
        <PasswordEncryption refresh={refresh} status={status} />
      ) : (
        <TouchIdEncryption refresh={refresh} status={status} />
      )}
      {status.encrypted ? (
        <RecoveryKeyRow refresh={refresh} status={status} />
      ) : null}
    </>
  );
}

function PasswordEncryption({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Removing encryption after an unlock with the recovery key does not ask for
  // a password the owner may have forgotten.
  const needsPassword = !(status.encrypted && status.recoveredSession);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setDialogOpen(nextOpen);
    if (!nextOpen) {
      setPassword("");
      setError(null);
    }
  }, []);

  const handleOpenClick = useCallback(() => setDialogOpen(true), []);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );

  const handleConfirm = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const action = status.encrypted
      ? disableEncryption(needsPassword ? password : null)
      : enableEncryption({ password });
    action
      .then(async () => {
        toast.success(
          status.encrypted ? "Encryption removed." : "Journal encrypted."
        );
        setDialogOpen(false);
        setPassword("");
        await refresh();
      })
      .catch(async (actionError: unknown) => {
        setError(
          lockErrorMessage(
            actionError,
            status.encrypted
              ? "Could not remove encryption."
              : "Could not encrypt the journal."
          )
        );
        await refresh();
      })
      .finally(() => setBusy(false));
  }, [busy, needsPassword, password, refresh, status.encrypted]);

  return (
    <>
      <SettingsRow
        description={status.encrypted ? encryptedOnDisk : encryptedOffDisk}
        title="Encryption"
      >
        <Button
          onClick={handleOpenClick}
          size="sm"
          variant={status.encrypted ? "destructive" : "outline"}
        >
          {status.encrypted ? "Remove encryption" : "Encrypt journal"}
        </Button>
      </SettingsRow>
      <Dialog onOpenChange={handleOpenChange} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {status.encrypted
                ? "Remove encryption?"
                : "Encrypt your journal?"}
            </DialogTitle>
            <DialogDescription>
              {status.encrypted
                ? "Entries are written back as plain text. Anyone who can open this Mac can read the journal file."
                : "Entries are encrypted with your password. If you forget the password, your pages cannot be recovered. A recovery key, which you can make after, is the only backup."}
            </DialogDescription>
          </DialogHeader>
          {needsPassword ? (
            <Field>
              <FieldLabel htmlFor="settings-encryption-password">
                Password
              </FieldLabel>
              <Input
                autoComplete="current-password"
                disabled={busy}
                id="settings-encryption-password"
                onChange={handlePasswordChange}
                type="password"
                value={password}
              />
              <FieldError>{error}</FieldError>
            </Field>
          ) : (
            <FieldError>{error}</FieldError>
          )}
          <DialogActions>
            <DialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={busy || (needsPassword && password.length === 0)}
              onClick={handleConfirm}
              variant={status.encrypted ? "destructive" : "default"}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {status.encrypted ? "Remove encryption" : "Encrypt journal"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

// With Touch ID as the only method there is no password to wrap the journal
// key, so Sage makes a recovery key, shows it once, and has it typed back
// before anything is encrypted. Touch ID opens the journal day to day through
// the Keychain copy of the key.
function TouchIdEncryption({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEncryptClick = useCallback(() => setEncryptOpen(true), []);
  const handleRemoveClick = useCallback(() => {
    setError(null);
    setRemoveOpen(true);
  }, []);
  const handleNoPassword = useCallback(() => requestRecoveryKey(null), []);

  const handleEncryptConfirm = useCallback(
    async (recoveryKey: string) => {
      try {
        await enableEncryption({ recoveryKey });
        toast.success("Journal encrypted.");
      } finally {
        await refresh();
      }
    },
    [refresh]
  );

  const handleRemoveConfirm = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    // With no password set, the promise settles when the system sheet does.
    disableEncryption(null)
      .then(async () => {
        toast.success("Encryption removed.");
        setRemoveOpen(false);
        await refresh();
      })
      .catch(async (removeError: unknown) => {
        setError(lockErrorMessage(removeError, "Could not remove encryption."));
        await refresh();
      })
      .finally(() => setBusy(false));
  }, [busy, refresh]);

  const handleRemoveOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!(nextOpen || busy)) {
        setRemoveOpen(false);
      }
    },
    [busy]
  );

  const fileVaultOff = status.fileVault === "off";

  return (
    <>
      <SettingsRow
        description={status.encrypted ? encryptedOnDisk : encryptedOffDisk}
        title="Encryption"
      >
        {status.encrypted ? (
          <Button onClick={handleRemoveClick} size="sm" variant="destructive">
            Remove encryption
          </Button>
        ) : (
          <Button onClick={handleEncryptClick} size="sm" variant="outline">
            Encrypt journal
          </Button>
        )}
      </SettingsRow>
      <RecoveryKeyDialog
        confirmLabel="Encrypt journal"
        getKey={handleNoPassword}
        intro={`Entries are encrypted with a key that Touch ID unlocks. Sage will show you a recovery key to save. If Touch ID can no longer open your journal, the recovery key is the only way back in.${fileVaultOff ? ` ${fileVaultOffMessage}` : ""}`}
        needsPassword={false}
        onConfirm={handleEncryptConfirm}
        onOpenChange={setEncryptOpen}
        open={encryptOpen}
        title="Encrypt your journal?"
        touchIdOnly
      />
      <Dialog onOpenChange={handleRemoveOpenChange} open={removeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove encryption?</DialogTitle>
            <DialogDescription>
              {`Entries are written back as plain text. Anyone who can open this Mac can read the journal file.${status.recoveredSession ? "" : " Touch ID asks you to confirm."}`}
            </DialogDescription>
          </DialogHeader>
          <FieldError>{error}</FieldError>
          <DialogActions>
            <DialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={busy}
              onClick={handleRemoveConfirm}
              variant="destructive"
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Remove encryption
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

// A new recovery key replaces the old one, which stops working. The password
// is the proof when one is set; with Touch ID alone it is a system sheet.
function RecoveryKeyRow({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [open, setOpen] = useState(false);
  const handleOpenClick = useCallback(() => setOpen(true), []);
  const handleConfirm = useCallback(
    async (recoveryKey: string) => {
      await saveRecoveryKey(recoveryKey);
      toast.success("Recovery key saved.");
      await refresh();
    },
    [refresh]
  );

  return (
    <>
      <SettingsRow
        description={
          status.recoveryKeySet
            ? "A recovery key opens your journal if your password or Touch ID cannot."
            : "No recovery key yet. Make one so a forgotten password or a lost Keychain item cannot cost you your pages."
        }
        title="Recovery key"
      >
        <Button onClick={handleOpenClick} size="sm" variant="outline">
          {status.recoveryKeySet
            ? "Make a new recovery key"
            : "Make a recovery key"}
        </Button>
      </SettingsRow>
      <RecoveryKeyDialog
        confirmLabel="Save recovery key"
        getKey={requestRecoveryKey}
        intro={
          status.recoveryKeySet
            ? "The old recovery key stops working once you save the new one."
            : "Sage will show you a key to save somewhere safe."
        }
        needsPassword={status.passwordSet && !status.recoveredSession}
        onConfirm={handleConfirm}
        onOpenChange={setOpen}
        open={open}
        title="Make a recovery key"
        touchIdOnly={!status.passwordSet}
      />
    </>
  );
}
