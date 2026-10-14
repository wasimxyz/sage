import { toast } from "sonner";

import {
  type CommitResult,
  commit,
  type DeleteKind,
  hide,
  isHidden,
  undo,
} from "./pending-deletes.ts";

const undoWindowMs = 5000;
const titleLimit = 40;

/** A title short enough for a toast, or a plain word when there is none. */
export function toastTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.length > titleLimit
    ? `${trimmed.slice(0, titleLimit - 1)}…`
    : trimmed;
}

/**
 * Hide a row now and delete it for real once the toast closes. Undo shows the
 * row again. The toast closes on its own after a few seconds, or when it is
 * dismissed. Sonner calls neither handler for the Undo button, so Undo never
 * commits.
 *
 * A row that is already waiting gets no second delete, so a held key or a
 * double click cannot queue two toasts for one row.
 */
export function deleteWithUndo({
  commit: run,
  id,
  kind,
  message,
  onUndo,
}: {
  commit: () => Promise<CommitResult>;
  id: number;
  kind: DeleteKind;
  message: string;
  /** Called after Undo shows the row again. */
  onUndo?: () => void;
}): void {
  if (isHidden(kind, id)) {
    return;
  }
  let key = "";
  // Close the toast once the delete is settled, however that came about: an
  // export or Dream can run it early, and a toast brought back after an unlock
  // must not offer an Undo that no longer works.
  const settle = async (): Promise<CommitResult> => {
    const result = await run();
    if (result !== "retry") {
      toast.dismiss(key);
    }
    return result;
  };
  key = hide(kind, id, settle);
  const finish = () => {
    commit(key).catch(() => undefined);
  };
  toast(message, {
    action: {
      label: "Undo",
      onClick: () => {
        if (undo(key)) {
          onUndo?.();
        } else {
          toast.error("Too late to undo.");
        }
      },
    },
    duration: undoWindowMs,
    id: key,
    onAutoClose: finish,
    onDismiss: finish,
  });
}
