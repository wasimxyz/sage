import {
  LeafIcon,
  MessageCircleIcon,
  MoonStarIcon,
  PencilLineIcon,
} from "lucide-react";
import { type ComponentType, useCallback } from "react";
import { useOnboarding } from "@/components/onboarding-provider";
import {
  SetupBody,
  SetupFrame,
  SetupHeader,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import { Button } from "@/components/ui/button";

const features: ReadonlyArray<{
  description: string;
  icon: ComponentType;
  title: string;
}> = [
  {
    description:
      "Keep a journal in a simple editor, or import the one you already have.",
    icon: PencilLineIcon,
    title: "Write",
  },
  {
    description:
      "Ask questions about your entries. Sage answers only from what you wrote.",
    icon: MessageCircleIcon,
    title: "Chat",
  },
  {
    description:
      "Click Dream after you write. Sage summarizes new entries so Chat can find them.",
    icon: MoonStarIcon,
    title: "Dream",
  },
];

export function SetupWelcome() {
  const {
    actions: { goTo, skipSetup },
  } = useOnboarding();
  const handleStart = useCallback(() => goTo("local_ai"), [goTo]);

  return (
    <SetupFrame>
      <SetupHeader onSkip={skipSetup} />
      <SetupBody>
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <LeafIcon className="size-6" />
        </div>
        <SetupTitle>Welcome to Sage</SetupTitle>
        <SetupText>
          A private journal with an AI you can talk to. Everything runs on this
          Mac, so your entries, chats, and memories never leave it.
        </SetupText>
        <ul className="flex flex-col gap-3">
          {features.map(({ description, icon: Icon, title }) => (
            <li className="flex items-start gap-3" key={title}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card [&_svg]:size-4">
                <Icon />
              </span>
              <div className="flex flex-col">
                <span className="font-medium text-sm">{title}</span>
                <span className="text-muted-foreground text-sm">
                  {description}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleStart}>Get started</Button>
          <span className="text-muted-foreground text-xs">
            Setup has 3 short steps. You can skip any of them.
          </span>
        </div>
      </SetupBody>
    </SetupFrame>
  );
}
