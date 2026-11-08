import { CheckIcon, FileIcon } from "lucide-react";
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
            className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
            role="status"
          >
            <CheckIcon className="text-primary size-4" />
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
        <div className="bg-card flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-8 text-center">
          <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
            <FileIcon className="size-4" />
          </span>
          <Button onClick={handleChoose}>Choose files…</Button>
          <p className="text-muted-foreground max-w-72 text-xs text-pretty">
            Pick .md, .markdown, or .txt files, up to 1 MB each. You&apos;ll see
            a preview before anything is saved.
          </p>
        </div>
        <SetupText className="-mt-2 text-xs">
          Sage takes each entry&apos;s title and date from the file.
        </SetupText>
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
