import { LockIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLock } from "@/components/lock-provider";
import { useOnboarding } from "@/components/onboarding-provider";
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
import {
  type ReminderNumber,
  reminderDue,
  remindersLeftLine,
} from "@/lib/onboarding";

/**
 * Asks someone who skipped Protect to turn on a lock and encryption, up to
 * three times. It lives on Home and waits for Home to load, so it never opens
 * over the editor or Chat. It counts the reminder when the dialog appears, so
 * quitting with it open still counts.
 */
export function ProtectReminder({ ready }: { ready: boolean }) {
  const {
    actions: { openProtect, recordReminderShown, stopReminders },
    state: { status },
  } = useOnboarding();
  const {
    state: { status: lock },
  } = useLock();
  // `reminder` stays after the dialog closes, so its text does not change
  // while it fades out.
  const [reminder, setReminder] = useState<ReminderNumber | null>(null);
  const [open, setOpen] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (!ready || decided.current || status === null || lock === null) {
      return;
    }
    decided.current = true;
    const due = reminderDue({
      encrypted: lock.encrypted,
      nowMs: Date.now(),
      ranSetupThisLaunch: status.ranSetupThisLaunch,
      reminderLastAtMs: status.reminderLastAtMs,
      reminderShownThisLaunch: status.reminderShownThisLaunch,
      remindersOff: status.remindersOff,
      remindersShown: status.remindersShown,
      state: status.state,
    });
    if (due === null) {
      return;
    }
    recordReminderShown()
      .then(() => {
        setReminder(due);
        setOpen(true);
      })
      .catch(() => undefined);
  }, [lock, ready, recordReminderShown, status]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setOpen(false);
    }
  }, []);
  const handleSetUp = useCallback(() => {
    setOpen(false);
    openProtect();
  }, [openProtect]);
  const handleStop = useCallback(() => {
    setOpen(false);
    stopReminders().catch(() => undefined);
  }, [stopReminders]);

  const last = reminder === 3;
  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
            <LockIcon className="size-4" />
          </span>
          <DialogTitle>
            {last
              ? "Last reminder: protect your journal"
              : "Protect your journal"}
          </DialogTitle>
          <DialogDescription>
            {last
              ? "Your entries and chats are still readable by any app on this Mac. After this, Sage won't ask again. You can set this up any time in Settings › Security."
              : "Right now, any app on this Mac can read your entries and chats. Setting up a lock and encryption takes about a minute."}
          </DialogDescription>
        </DialogHeader>
        <DialogActions>
          {last ? (
            <Button onClick={handleStop} variant="outline">
              Don&apos;t ask again
            </Button>
          ) : (
            <DialogClose render={<Button variant="outline" />}>
              Not now
            </DialogClose>
          )}
          <Button onClick={handleSetUp}>Set up now</Button>
        </DialogActions>
        {reminder === null || last ? null : (
          <p className="text-muted-foreground text-xs">
            {remindersLeftLine(reminder)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
