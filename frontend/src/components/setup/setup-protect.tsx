import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import { useOnboarding } from "@/components/onboarding-provider";
import {
  ProtectFlow,
  type ProtectResult,
} from "@/components/setup/protect-flow";
import { ReminderHeader, SetupHeader } from "@/components/setup/setup-frame";

/** Step 2 of first-launch setup. */
export function SetupProtect() {
  const {
    actions: { goTo, rememberChoice, skipSetup },
    state: { status },
  } = useOnboarding();
  const encrypt = status?.encrypt ?? false;
  const method = status?.method ?? null;
  const saved = useMemo(() => ({ encrypt, method }), [encrypt, method]);
  const handleBack = useCallback(() => goTo("local_ai"), [goTo]);
  const handleNext = useCallback(() => goTo("import"), [goTo]);

  return (
    <ProtectFlow
      onBack={handleBack}
      onChoose={rememberChoice}
      onDone={handleNext}
      onSkip={handleNext}
      saved={saved}
    >
      <SetupHeader onSkip={skipSetup} step={2} />
    </ProtectFlow>
  );
}

/**
 * The Protect screens on their own, from the reminder's Set up now. There is no
 * step count and no Skip setup, and finishing returns to Home.
 */
export function ReminderProtect() {
  const {
    actions: { closeProtect },
  } = useOnboarding();
  const handleDone = useCallback(
    ({ encrypted }: ProtectResult) => {
      toast.success(encrypted ? "Lock and encryption are on." : "Lock is on.");
      closeProtect();
    },
    [closeProtect]
  );

  return (
    <ProtectFlow onDone={handleDone}>
      <ReminderHeader onCancel={closeProtect} />
    </ProtectFlow>
  );
}
