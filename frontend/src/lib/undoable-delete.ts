import { toast } from "sonner";

import {
  type CommitResult,
  commit,
  type DeleteKind,
  hide,
  undo,
} from "./pending-deletes.ts";

const undoWindowMs = 5000;

/**
 * Hide a row now and delete it for real once the toast closes. Undo shows the
 * row again. The toast closes on its own after a few seconds, or when it is
 * dismissed. Sonner calls neither handler for the Undo button, so Undo never
 * commits.
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
  const key = hide(kind, id, run);
  const settle = () => {
    commit(key).catch(() => undefined);
  };
  toast(message, {
    action: {
      label: "Undo",
      onClick: () => {
        if (undo(key)) {
          onUndo?.();
        } else {
          toast.error("Too late to undo. This was already deleted.");
        }
      },
    },
    duration: undoWindowMs,
    id: key,
    onAutoClose: settle,
    onDismiss: settle,
  });
}
