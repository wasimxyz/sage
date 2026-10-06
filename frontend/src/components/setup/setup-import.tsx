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
  SetupIntro,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import { Button } from "@/components/ui/button";
import { protectionBanner, setupProtectScreen } from "@/lib/onboarding";

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

  const banner = lock ? protectionBanner(lock) : null;
  // Back skips Protect when it has nothing left to ask, or it would send the
  // person forward again.
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
  const handleBack = useCallback(
    () => goTo(protectDone ? "local_ai" : "protect"),
    [goTo, protectDone]
  );
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
        <SetupIntro>
          <SetupTitle>Bring in your writing</SetupTitle>
          <SetupText>
            Already keep a journal? Import Markdown files from Notion or any
            other app. This step is optional.
          </SetupText>
        </SetupIntro>
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
