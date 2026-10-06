import { CheckIcon, FileUpIcon } from "lucide-react";
import { useCallback } from "react";

import { useFileMenu } from "@/components/file-menu-provider";
import { useLock } from "@/components/lock-provider";
import { useOnboarding } from "@/components/onboarding-provider";
import {
  SetupBody,
  SetupFooter,
  SetupFrame,
  SetupHeader,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import { useSetupModels } from "@/components/setup/use-setup-models";
import { Button } from "@/components/ui/button";
import {
  localAiDone,
  protectionBanner,
  setupProtectScreen,
} from "@/lib/onboarding";

/** Step 3 of first-launch setup: bring in entries the person already has. */
export function SetupImport() {
  const {
    actions: { goTo, skipSetup },
    state: { status },
  } = useOnboarding();
  const {
    actions: { pickAndImport },
  } = useFileMenu();
  const {
    state: { status: lock },
  } = useLock();

  const { readiness } = useSetupModels();
  const banner = lock ? protectionBanner(lock) : null;
  // Back skips a step that had nothing to do, or it would send the person
  // forward again.
  const protectDone =
    lock !== null &&
    setupProtectScreen(lock, {
      encrypt: status?.encrypt ?? false,
      method: status?.method ?? null,
    }) === "done";

  const handleChoose = useCallback(
    () => pickAndImport(() => goTo("all_set")),
    [goTo, pickAndImport]
  );
  const skipLocalAi = localAiDone(readiness);
  const handleBack = useCallback(() => {
    if (!protectDone) {
      goTo("protect");
      return;
    }
    goTo(skipLocalAi ? "welcome" : "local_ai");
  }, [goTo, protectDone, skipLocalAi]);
  const handleSkip = useCallback(() => goTo("all_set"), [goTo]);

  return (
    <SetupFrame>
      <SetupHeader onSkip={skipSetup} step={3} />
      <SetupBody>
        {banner ? (
          <p
            className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
            role="status"
          >
            <CheckIcon className="size-4 text-primary" />
            {banner}
          </p>
        ) : null}
        <SetupTitle>Bring in your writing</SetupTitle>
        <SetupText>
          Already keep a journal? Import Markdown files from Notion or any other
          app. This step is optional.
        </SetupText>
        <div className="flex flex-col items-start gap-2">
          <Button onClick={handleChoose}>
            <FileUpIcon data-icon="inline-start" />
            Choose files…
          </Button>
          <SetupText className="text-xs">
            Pick .md, .markdown, or .txt files, up to 1 MB each. You&apos;ll see
            a preview before anything is saved.
          </SetupText>
        </div>
        <SetupFooter>
          <Button onClick={handleBack} variant="ghost">
            Back
          </Button>
          <Button onClick={handleSkip} variant="outline">
            Skip
          </Button>
        </SetupFooter>
      </SetupBody>
    </SetupFrame>
  );
}
