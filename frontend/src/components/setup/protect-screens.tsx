import { FingerprintIcon, InfoIcon } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
} from "react";

import type { UnlockMethod } from "@/bridge";
import { IdleTimeoutSelect } from "@/components/idle-timeout-select";
import {
  RecoveryKeyCard,
  useRecoveryKeyClipboard,
} from "@/components/recovery-key-display";
import {
  SetupFooter,
  SetupFooterEnd,
  SetupIntro,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";

// Every screen here only draws. `ProtectFlow` owns the lock and encryption
// calls, and hands each screen what it shows and what to do next.

const noReset =
  "If Touch ID stops working or you forget your password, and you've also lost your recovery key, Sage can't open your journal. There is no reset.";

/**
 * The no-reset warning as small grey text across the full column, with an info
 * icon, not a boxed alert. `text-wrap` turns off the balanced wrapping that
 * would narrow it. The negative top margin pulls it closer to the block above
 * than the column's usual gap.
 */
function NoResetNote() {
  return (
    <p className="-mt-2 flex items-start gap-2 text-wrap text-muted-foreground text-xs">
      <InfoIcon className="mt-px size-3.5 shrink-0" />
      {noReset}
    </p>
  );
}

function SubmitButton({
  busy,
  children,
  disabled,
}: {
  busy: boolean;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button disabled={busy || disabled} type="submit">
      {busy ? <Spinner data-icon="inline-start" /> : null}
      {children}
    </Button>
  );
}

export function ChooseScreen({
  encrypt,
  method,
  onBack,
  onContinue,
  onEncryptChange,
  onMethodChange,
  onSkip,
  touchIdAvailable,
  touchIdReady,
}: {
  encrypt: boolean;
  method: UnlockMethod;
  onBack?: () => void;
  onContinue: () => void;
  onEncryptChange: (encrypt: boolean) => void;
  onMethodChange: (method: UnlockMethod) => void;
  onSkip?: () => void;
  /** This Mac has a Touch ID sensor. */
  touchIdAvailable: boolean;
  /** The sensor works right now. False with the lid closed, for example. */
  touchIdReady: boolean;
}) {
  const handleMethod = useCallback(
    (value: unknown) => {
      if (value === "touch_id" || value === "password") {
        onMethodChange(value);
      }
    },
    [onMethodChange]
  );
  const handleEncrypt = useCallback(
    (checked: boolean) => onEncryptChange(checked),
    [onEncryptChange]
  );

  return (
    <>
      <SetupIntro>
        <SetupTitle>Protect your journal</SetupTitle>
        <SetupText>
          Other apps on this Mac, including AI agents, can open files. A lock
          keeps people out of Sage. Encryption stops other apps from reading
          your journal file.
        </SetupText>
      </SetupIntro>
      <FieldSet>
        <FieldLegend variant="label">
          How do you want to unlock Sage?
        </FieldLegend>
        <RadioGroup onValueChange={handleMethod} value={method}>
          {touchIdAvailable ? (
            <FieldLabel htmlFor="unlock-touch-id">
              <Field orientation="horizontal">
                <RadioGroupItem id="unlock-touch-id" value="touch_id" />
                <FieldContent>
                  <FieldTitle>
                    Touch ID <Badge variant="secondary">Recommended</Badge>
                  </FieldTitle>
                  <FieldDescription>
                    Unlock with your fingerprint. There&apos;s no password to
                    remember.
                    {touchIdReady
                      ? null
                      : " Touch ID isn't available right now, so macOS asks for your Mac password until it is."}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ) : null}
          <FieldLabel htmlFor="unlock-password">
            <Field orientation="horizontal">
              <RadioGroupItem id="unlock-password" value="password" />
              <FieldContent>
                <FieldTitle>Password</FieldTitle>
                <FieldDescription>
                  Type a password of at least 8 characters each time.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Enable encryption?</FieldLegend>
        <FieldLabel htmlFor="encrypt-journal">
          <Field orientation="horizontal">
            <Checkbox
              checked={encrypt}
              id="encrypt-journal"
              onCheckedChange={handleEncrypt}
            />
            <FieldContent>
              <FieldTitle>
                Encrypt my journal{" "}
                <Badge variant="secondary">Recommended</Badge>
              </FieldTitle>
              <FieldDescription>
                Entries, chats, and memories are saved in a form other apps
                can&apos;t read until you unlock Sage.
                {encrypt ? " You'll save a recovery key next." : null}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      </FieldSet>
      <NoResetNote />
      <SetupFooter>
        {onBack ? (
          <Button onClick={onBack} variant="ghost">
            Back
          </Button>
        ) : (
          <span />
        )}
        <SetupFooterEnd>
          {onSkip ? (
            <Button onClick={onSkip} variant="outline">
              Set up later
            </Button>
          ) : null}
          <Button onClick={onContinue}>Continue</Button>
        </SetupFooterEnd>
      </SetupFooter>
    </>
  );
}

function IdleTimeoutField({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (idleTimeoutMs: number) => void;
  value: number;
}) {
  return (
    <Field
      className="items-center justify-between rounded-xl border bg-card px-4 py-3"
      orientation="horizontal"
    >
      <FieldLabel htmlFor="setup-idle-timeout">
        Lock Sage after I&apos;m away for
      </FieldLabel>
      <IdleTimeoutSelect
        disabled={disabled}
        id="setup-idle-timeout"
        onChange={onChange}
        value={value}
      />
    </Field>
  );
}

export function TouchIdScreen({
  busy,
  encrypt,
  error,
  idleTimeoutMs,
  onBack,
  onIdleChange,
  onUse,
}: {
  busy: boolean;
  encrypt: boolean;
  error: string | null;
  idleTimeoutMs: number;
  onBack: () => void;
  onIdleChange: (idleTimeoutMs: number) => void;
  onUse: () => void;
}) {
  return (
    <>
      <SetupIntro>
        <SetupTitle>Turn on Touch ID</SetupTitle>
        <SetupText>
          Sage will ask for your fingerprint when it opens, after your Mac
          sleeps, and after you&apos;ve been away.
        </SetupText>
      </SetupIntro>
      {encrypt ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border bg-card px-6 py-8 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-muted">
            <FingerprintIcon className="size-6" />
          </span>
          <p className="max-w-72 text-pretty text-sm">
            When you continue, macOS asks you to touch the sensor once to
            confirm it&apos;s you.
          </p>
        </div>
      ) : null}
      <IdleTimeoutField
        disabled={busy}
        onChange={onIdleChange}
        value={idleTimeoutMs}
      />
      {encrypt ? (
        <SetupText className="-mt-2 text-xs">
          Next, you&apos;ll save a recovery key. It&apos;s how you get in if
          Touch ID ever stops working.
        </SetupText>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      <SetupFooter>
        <Button disabled={busy} onClick={onBack} variant="ghost">
          Back
        </Button>
        <Button disabled={busy} onClick={onUse}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Use Touch ID
        </Button>
      </SetupFooter>
    </>
  );
}

export function PasswordScreen({
  busy,
  confirm,
  encrypt,
  error,
  idleTimeoutMs,
  onBack,
  onConfirmChange,
  onIdleChange,
  onPasswordChange,
  onSubmit,
  password,
}: {
  busy: boolean;
  confirm: string;
  encrypt: boolean;
  error: string | null;
  idleTimeoutMs: number;
  onBack: () => void;
  onConfirmChange: (value: string) => void;
  onIdleChange: (idleTimeoutMs: number) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  password: string;
}) {
  const handlePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onPasswordChange(event.target.value),
    [onPasswordChange]
  );
  const handleConfirm = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onConfirmChange(event.target.value),
    [onConfirmChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSubmit();
    },
    [onSubmit]
  );

  return (
    <form className="contents" onSubmit={handleSubmit}>
      <SetupIntro>
        <SetupTitle>Create a password</SetupTitle>
        <SetupText>
          You&apos;ll unlock Sage when it opens, after your Mac sleeps, and
          after you&apos;ve been away.
        </SetupText>
      </SetupIntro>
      <Field>
        <FieldLabel htmlFor="setup-password">Password</FieldLabel>
        <Input
          autoComplete="new-password"
          autoFocus
          disabled={busy}
          id="setup-password"
          onChange={handlePassword}
          placeholder="At least 8 characters"
          type="password"
          value={password}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="setup-password-confirm">Type it again</FieldLabel>
        <Input
          autoComplete="new-password"
          disabled={busy}
          id="setup-password-confirm"
          onChange={handleConfirm}
          type="password"
          value={confirm}
        />
        <FieldError>{error}</FieldError>
      </Field>
      <IdleTimeoutField
        disabled={busy}
        onChange={onIdleChange}
        value={idleTimeoutMs}
      />
      <Alert variant="warning">
        <InfoIcon />
        <AlertDescription>
          Keep this password somewhere safe, like a password manager.
          {encrypt ? " Next, you'll get a recovery key as a backup." : null}
        </AlertDescription>
      </Alert>
      <SetupFooter>
        <Button disabled={busy} onClick={onBack} type="button" variant="ghost">
          Back
        </Button>
        <SubmitButton
          busy={busy}
          disabled={password.length === 0 || confirm.length === 0}
        >
          Continue
        </SubmitButton>
      </SetupFooter>
    </form>
  );
}

/** For a lock that is already on: Sage skips the choice and goes to encryption. */
export function EncryptScreen({
  busy,
  error,
  needsPassword,
  onBack,
  onPasswordChange,
  onSkip,
  onSubmit,
  password,
}: {
  busy: boolean;
  error: string | null;
  needsPassword: boolean;
  onBack?: () => void;
  onPasswordChange: (value: string) => void;
  onSkip?: () => void;
  onSubmit: () => void;
  password: string;
}) {
  const handlePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onPasswordChange(event.target.value),
    [onPasswordChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSubmit();
    },
    [onSubmit]
  );

  return (
    <form className="contents" onSubmit={handleSubmit}>
      <SetupIntro>
        <SetupTitle>Encrypt your journal</SetupTitle>
        <SetupText>
          Your lock is on. Encryption stops other apps from reading your journal
          file. You&apos;ll save a recovery key next.
        </SetupText>
      </SetupIntro>
      {needsPassword ? (
        <Field>
          <FieldLabel htmlFor="setup-encrypt-password">
            Your password
          </FieldLabel>
          <Input
            autoComplete="current-password"
            autoFocus
            disabled={busy}
            id="setup-encrypt-password"
            onChange={handlePassword}
            type="password"
            value={password}
          />
          <FieldDescription>
            Sage asks so it knows it&apos;s you.
          </FieldDescription>
          <FieldError>{error}</FieldError>
        </Field>
      ) : (
        <>
          <SetupText>
            When you continue, macOS asks you to touch the sensor once to
            confirm it&apos;s you.
          </SetupText>
          {error ? <FieldError>{error}</FieldError> : null}
        </>
      )}
      <NoResetNote />
      <SetupFooter>
        {onBack ? (
          <Button
            disabled={busy}
            onClick={onBack}
            type="button"
            variant="ghost"
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        <SetupFooterEnd>
          {onSkip ? (
            <Button
              disabled={busy}
              onClick={onSkip}
              type="button"
              variant="outline"
            >
              Set up later
            </Button>
          ) : null}
          <SubmitButton
            busy={busy}
            disabled={needsPassword && password.length === 0}
          >
            Continue
          </SubmitButton>
        </SetupFooterEnd>
      </SetupFooter>
    </form>
  );
}

export function KeyScreen({
  onBack,
  onSaved,
  recoveryKey,
}: {
  onBack: () => void;
  onSaved: () => void;
  recoveryKey: string;
}) {
  const { clear, copied, copy } = useRecoveryKeyClipboard(recoveryKey);
  const handleSaved = useCallback(() => {
    clear();
    onSaved();
  }, [clear, onSaved]);

  return (
    <>
      <SetupIntro>
        <SetupTitle>Save your recovery key</SetupTitle>
        <SetupText>
          This key opens your journal if you forget your password or Touch ID
          stops working. Sage shows it only once.
        </SetupText>
      </SetupIntro>
      <RecoveryKeyCard
        copied={copied}
        onCopy={copy}
        recoveryKey={recoveryKey}
      />
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-xs">
        <li>Save it in a password manager, or write it on paper.</li>
        <li>Don&apos;t keep it only on this Mac.</li>
        <li>You can make a new key any time in Settings › Security.</li>
      </ul>
      <SetupFooter>
        <Button onClick={onBack} variant="ghost">
          Back
        </Button>
        <Button onClick={handleSaved}>I saved it</Button>
      </SetupFooter>
    </>
  );
}

export function ConfirmScreen({
  busy,
  error,
  onBack,
  onSubmit,
  onTypedChange,
  typed,
}: {
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: () => void;
  onTypedChange: (value: string) => void;
  typed: string;
}) {
  const handleTyped = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onTypedChange(event.target.value),
    [onTypedChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSubmit();
    },
    [onSubmit]
  );

  return (
    <form className="contents" onSubmit={handleSubmit}>
      <SetupIntro>
        <SetupTitle>Type your recovery key</SetupTitle>
        <SetupText>
          This checks that you saved it correctly. Type it from where you saved
          it, not from memory.
        </SetupText>
      </SetupIntro>
      <Field>
        <FieldLabel htmlFor="setup-recovery-key">Recovery key</FieldLabel>
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          autoFocus
          className="font-mono tracking-wider"
          disabled={busy}
          id="setup-recovery-key"
          onChange={handleTyped}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          value={typed}
        />
        <FieldDescription className="text-xs">
          Capital letters, dashes, and spaces don&apos;t matter.
        </FieldDescription>
        <FieldError>{error}</FieldError>
      </Field>
      <SetupText className="text-xs">
        When you continue, Sage encrypts your journal. This takes a moment.
      </SetupText>
      <SetupFooter>
        <Button disabled={busy} onClick={onBack} type="button" variant="ghost">
          Show the key again
        </Button>
        <SubmitButton busy={busy} disabled={typed.length === 0}>
          Turn on encryption
        </SubmitButton>
      </SetupFooter>
    </form>
  );
}
