import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  RecoveryKeyGrid,
  useRecoveryKeyClipboard,
} from "@/components/recovery-key-display";
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
import { lockErrorMessage } from "@/lib/lock-errors";
import { recoveryKeysMatch } from "@/lib/recovery-key";

type Step = "intro" | "show" | "confirm";

interface RecoveryKeyDialogProps {
  /** What the button that finishes the flow says, like "Encrypt journal". */
  confirmLabel: string;
  /**
   * Ask Sage for a key. Resolves once the proof is in: right away with a
   * password, or when the system sheet closes with Touch ID.
   */
  getKey: (password: string | null) => Promise<string>;
  /** Said first, before anything is asked of the system. */
  intro: ReactNode;
  /** Ask for the password first: it proves who is asking for a new key. */
  needsPassword: boolean;
  /**
   * Finish the change with the key the person typed back. The dialog closes
   * when this resolves and shows the message when it fails.
   */
  onConfirm: (recoveryKey: string, password: string | null) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  /**
   * Touch ID is the only other way in, so this key is the only way back. With
   * a password set, the key is a second way.
   */
  touchIdOnly: boolean;
}

/**
 * Shows a recovery key once and has the person type it back before anything
 * changes. Sage generates the key and holds it until `onConfirm` sends it
 * back, so this page can show a key but never choose one.
 */
export function RecoveryKeyDialog({
  confirmLabel,
  getKey,
  intro,
  needsPassword,
  onConfirm,
  onOpenChange,
  open,
  title,
  touchIdOnly,
}: RecoveryKeyDialogProps) {
  const [step, setStep] = useState<Step>("intro");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The key is on the clipboard only because the person asked for a copy.
  // Replace it once they say they saved it, or when the dialog goes away, so
  // it does not sit there for other apps and Universal Clipboard to read.
  const {
    clear: clearClipboard,
    copied,
    copy: handleCopy,
  } = useRecoveryKeyClipboard(recoveryKey);

  // Start over every time the dialog opens, and let go of the key and the
  // password when it closes so they do not sit in page state.
  useEffect(() => {
    setStep("intro");
    setTyped("");
    clearClipboard();
    setBusy(false);
    setError(null);
    if (!open) {
      setPassword("");
      setRecoveryKey("");
    }
  }, [clearClipboard, open]);

  const handlePasswordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );
  const handleTypedChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTyped(event.target.value),
    []
  );

  const handleContinue = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (busy) {
        return;
      }
      setBusy(true);
      setError(null);
      getKey(needsPassword ? password : null)
        .then((key) => {
          setRecoveryKey(key);
          setStep("show");
        })
        .catch((keyError: unknown) => {
          setError(
            lockErrorMessage(keyError, "Could not make a recovery key.")
          );
        })
        .finally(() => setBusy(false));
    },
    [busy, getKey, needsPassword, password]
  );

  const handleSaved = useCallback(() => {
    clearClipboard();
    setTyped("");
    setError(null);
    setStep("confirm");
  }, [clearClipboard]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep("show");
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      if (!recoveryKeysMatch(recoveryKey, typed)) {
        setError("That doesn't match. Check it against the key you saved.");
        return;
      }
      setBusy(true);
      setError(null);
      onConfirm(recoveryKey, needsPassword ? password : null)
        .then(() => onOpenChange(false))
        .catch((confirmError: unknown) => {
          setError(lockErrorMessage(confirmError, "Could not finish."));
        })
        .finally(() => setBusy(false));
    },
    [busy, needsPassword, onConfirm, onOpenChange, password, recoveryKey, typed]
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // A change that is already running finishes before the dialog goes.
      if (nextOpen || busy) {
        return;
      }
      onOpenChange(false);
    },
    [busy, onOpenChange]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        {step === "intro" ? (
          <form className="contents" onSubmit={handleContinue}>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{intro}</DialogDescription>
            </DialogHeader>
            {needsPassword ? (
              <Field>
                <FieldLabel htmlFor="recovery-key-password">
                  Password
                </FieldLabel>
                <Input
                  autoComplete="current-password"
                  autoFocus
                  disabled={busy}
                  id="recovery-key-password"
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
                render={<Button type="button" variant="outline" />}
              >
                Cancel
              </DialogClose>
              <Button
                disabled={busy || (needsPassword && password.length === 0)}
                type="submit"
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Continue
              </Button>
            </DialogActions>
          </form>
        ) : null}
        {step === "show" ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery key</DialogTitle>
              <DialogDescription>
                Sage shows this key once. Write it down or keep it in a password
                manager.{" "}
                {touchIdOnly
                  ? "If Touch ID can no longer open your journal, this key is the only way back in."
                  : "It opens your journal if you forget your password or Touch ID can no longer open it."}
              </DialogDescription>
            </DialogHeader>
            <RecoveryKeyGrid
              copied={copied}
              onCopy={handleCopy}
              recoveryKey={recoveryKey}
            />
            <DialogActions>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button onClick={handleSaved} type="button">
                I saved it
              </Button>
            </DialogActions>
          </>
        ) : null}
        {step === "confirm" ? (
          <form className="contents" onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Type your recovery key</DialogTitle>
              <DialogDescription>
                Type the key from the copy you saved, so Sage knows it works.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="recovery-key-typed">Recovery key</FieldLabel>
              <Input
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                autoFocus
                className="font-mono tracking-wider"
                disabled={busy}
                id="recovery-key-typed"
                onChange={handleTypedChange}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                spellCheck={false}
                value={typed}
              />
              <FieldError>{error}</FieldError>
            </Field>
            <DialogActions>
              <Button
                disabled={busy}
                onClick={handleBack}
                type="button"
                variant="outline"
              >
                Show it again
              </Button>
              <Button disabled={busy || typed.length === 0} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {confirmLabel}
              </Button>
            </DialogActions>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
