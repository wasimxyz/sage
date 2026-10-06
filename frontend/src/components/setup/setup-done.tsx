import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect } from "react";

import { useLock } from "@/components/lock-provider";
import { useOnboarding } from "@/components/onboarding-provider";
import { ModelStatusLine } from "@/components/setup/model-rows";
import {
  PlainHeader,
  SetupBody,
  SetupFooter,
  SetupFooterEnd,
  SetupFrame,
  SetupList,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import { useSetupModels } from "@/components/setup/use-setup-models";
import { Button } from "@/components/ui/button";
import { lockTip } from "@/lib/idle-timeout";
import { protectionLine } from "@/lib/onboarding";

/** The last screen. It marks setup done, and shows what is really on now. */
export function SetupDone() {
  const {
    actions: { finishSetup, leaveSetup, leaveSetupToDraft },
  } = useOnboarding();
  const {
    state: { status: lock },
  } = useLock();
  const { rows } = useSetupModels();

  useEffect(() => {
    finishSetup();
  }, [finishSetup]);

  const protection = lock ? protectionLine(lock) : null;
  const waiting = rows.some(
    ({ state }) => state.kind !== "ready" && state.kind !== "unavailable"
  );
  const unavailable = rows.some(({ state }) => state.kind === "unavailable");

  let intro = "You can start writing now.";
  if (unavailable) {
    intro +=
      " Chat and Dream start working once you finish local AI in Settings › Models.";
  } else if (waiting) {
    intro +=
      " Chat and Dream start working when the last model finishes downloading.";
  }

  return (
    <SetupFrame>
      <PlainHeader />
      <SetupBody>
        <SetupTitle>You&apos;re all set</SetupTitle>
        <SetupText>{intro}</SetupText>
        <SetupList>
          {protection ? (
            <div className="flex items-center gap-2 p-3 text-sm">
              {protection.on ? (
                <CheckIcon className="size-4 text-primary" />
              ) : (
                <CircleAlertIcon className="size-4 text-muted-foreground" />
              )}
              {protection.text}
            </div>
          ) : null}
          {rows.map((row) => (
            <ModelStatusLine key={row.name} name={row.name} state={row.state} />
          ))}
        </SetupList>
        <div className="flex flex-col gap-2">
          <h2 className="font-medium text-sm">Good to know</h2>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              Click Dream in the sidebar after you write. Chat only finds
              entries that Dream has summarized.
            </li>
            <li>Press ⌘K to search your entries and chats.</li>
            <li>{lock ? lockTip(lock) : null}</li>
          </ul>
        </div>
        <SetupFooter>
          <SetupFooterEnd>
            <Button onClick={leaveSetupToDraft}>Write your first entry</Button>
            <Button onClick={leaveSetup} variant="outline">
              Go to Home
            </Button>
          </SetupFooterEnd>
        </SetupFooter>
      </SetupBody>
    </SetupFrame>
  );
}
