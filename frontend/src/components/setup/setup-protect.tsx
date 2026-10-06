import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import { useOnboarding } from "@/components/onboarding-provider";
import {
  ProtectFlow,
  type ProtectResult,
} from "@/components/setup/protect-flow";
import { ReminderHeader, SetupHeader } from "@/components/setup/setup-frame";
import { useSetupModels } from "@/components/setup/use-setup-models";
import { localAiDone } from "@/lib/onboarding";

/** Step 2 of first-launch setup. */
export function SetupProtect() {
  const {
    actions: { goTo, rememberChoice, skipSetup },
    state: { status },
  } = useOnboarding();
  const encrypt = status?.encrypt ?? false;
  const method = status?.method ?? null;
  const saved = useMemo(() => ({ encrypt, method }), [encrypt, method]);
  // Back skips Local AI when it had nothing to do, or it would send the person
  // forward again.
  const { readiness } = useSetupModels();
  const skipLocalAi = localAiDone(readiness);
  const handleBack = useCallback(
    () => goTo(skipLocalAi ? "welcome" : "local_ai"),
    [goTo, skipLocalAi]
  );
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
