import { useCallback, useState } from "react";
import { toast } from "sonner";

import { type LockStatus, requestRecoveryKey, saveRecoveryKey } from "@/bridge";
import { RecoveryKeyDialog } from "@/components/recovery-key-dialog";

/**
 * Asks for a new recovery key after an unlock with the old one, which is no
 * longer a secret. Sage keeps asking on later launches until one is saved.
 * Dismissing is fine for now.
 */
export function RecoveryKeyRotationPrompt({
  refresh,
  status,
}: {
  refresh: () => Promise<void>;
  status: LockStatus;
}) {
  const [open, setOpen] = useState(true);

  const handleConfirm = useCallback(
    async (recoveryKey: string) => {
      await saveRecoveryKey(recoveryKey);
      toast.success("Recovery key saved.");
      await refresh();
    },
    [refresh]
  );

  return (
    <RecoveryKeyDialog
      confirmLabel="Save recovery key"
      getKey={requestRecoveryKey}
      intro="You unlocked with your recovery key, so it is no longer a secret. Make a new one and keep it somewhere safe."
      needsPassword={status.passwordSet && !status.recoveredSession}
      onConfirm={handleConfirm}
      onOpenChange={setOpen}
      open={open}
      title="Make a new recovery key"
      touchIdOnly={!status.passwordSet}
    />
  );
}
