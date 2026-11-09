import { LeafIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { Button } from "@/components/ui/button";
import { useTitlebarAlignment } from "@/hooks/use-titlebar-alignment";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";
import { cn } from "@/lib/utils";

const stepCount = 3;

/**
 * The whole window for a setup screen, with no sidebar. Put one header and one
 * body inside it. The title bar strip stays draggable and clears the traffic
 * lights, the same way the lock screen does.
 */
export function SetupFrame({ children }: { children: ReactNode }) {
  const fullscreen = useWindowFullscreen();
  return (
    <div
      className="bg-background flex min-h-0 min-w-0 flex-1 flex-col"
      style={
        {
          "--titlebar-leading": fullscreen ? "0.5rem" : "5.375rem",
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

function HeaderBar({ children }: { children?: ReactNode }) {
  // The native traffic lights line up with this row, the way they do with the
  // app's own title bar.
  const rowRef = useTitlebarAlignment<HTMLElement>();
  return (
    <header
      className="relative flex h-(--titlebar-height) shrink-0 items-center justify-between pr-6 pl-[calc(var(--titlebar-leading)+0.5rem)]"
      data-slot="window-titlebar"
      onPointerDown={onTitlebarPointerDown}
      ref={rowRef}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <LeafIcon className="size-4" />
        Sage
      </div>
      {children}
    </header>
  );
}

const stepNumbers = [1, 2, 3] as const;

/**
 * "Step N of 3" with one segment per step. The steps so far are filled in. It
 * spans the whole header to stay centered and sits on top of Skip setup, so it
 * lets clicks through to the button and the draggable strip below.
 */
function StepIndicator({ step }: { step: number }) {
  return (
    <div className="text-muted-foreground pointer-events-none absolute inset-x-0 flex items-center justify-center gap-3 text-xs">
      <span>
        Step {step} of {stepCount}
      </span>
      <span aria-hidden className="flex gap-1.5">
        {stepNumbers.map((number) => (
          <span
            className={cn(
              "h-0.5 w-6 rounded-full",
              number <= step ? "bg-foreground" : "bg-muted"
            )}
            key={number}
          />
        ))}
      </span>
    </div>
  );
}

/** Logo, the step count when there is one, and Skip setup. */
export function SetupHeader({
  onSkip,
  step,
}: {
  onSkip: () => void;
  /** 1, 2, or 3. Leave it out on Welcome. */
  step?: number;
}) {
  return (
    <HeaderBar>
      {step === undefined ? null : <StepIndicator step={step} />}
      <Button onClick={onSkip} size="sm" variant="ghost">
        Skip setup
      </Button>
    </HeaderBar>
  );
}

/** Logo and Cancel, for the Protect screens a reminder opens. */
export function ReminderHeader({ onCancel }: { onCancel: () => void }) {
  return (
    <HeaderBar>
      <Button onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </HeaderBar>
  );
}

/** Logo only, for All set. */
export function PlainHeader() {
  return <HeaderBar />;
}

/** The scrolling area that centers one screen's content. */
export function SetupBody({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 overflow-y-auto px-6">
      <div className="mx-auto my-auto flex w-full max-w-120 flex-col gap-6 py-10 pb-16">
        {children}
      </div>
    </main>
  );
}

/**
 * A title and the paragraph that explains it. They sit closer together than the
 * other blocks on the screen, so the two read as one heading.
 */
export function SetupIntro({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

export function SetupTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>;
}

export function SetupText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-muted-foreground text-sm text-pretty", className)}>
      {children}
    </p>
  );
}

/** A bordered list of rows, one after another. */
export function SetupList({ children }: { children: ReactNode }) {
  return (
    <div className="bg-card flex flex-col divide-y rounded-lg border">
      {children}
    </div>
  );
}

/** Buttons along the bottom of a screen, with the back or skip choice on the left. */
export function SetupFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3">
      {children}
    </footer>
  );
}

export function SetupFooterEnd({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3">{children}</div>;
}

export function SetupNote({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground max-w-56 text-xs">{children}</p>;
}
