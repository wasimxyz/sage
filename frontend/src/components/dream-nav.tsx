import { MoonStarIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { useDream } from "@/components/dream-provider";
import { Hint } from "@/components/hint";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ollamaDownDreamPrompt } from "@/lib/dream-errors";
import { formatDreamProgress } from "@/lib/dream-progress";
import { formatLastDreamed } from "@/lib/format-relative-age";
import { cn } from "@/lib/utils";

const ageTickMs = 60_000;

/**
 * Dream's row at the bottom of the sidebar, on both tabs. While Dream runs,
 * the percent shows under it.
 */
export function DreamNavItem({ className }: { className?: string }) {
  return (
    <SidebarMenuItem>
      <DreamMenu className={className} />
      <DreamStatusLine />
    </SidebarMenuItem>
  );
}

/**
 * Dream's end and failures already toast. This covers the silent start. It
 * lives at the top of the app, because the sidebar can be closed or showing
 * another menu when Dream starts.
 */
export function DreamStartAnnouncement() {
  const {
    state: { running },
  } = useDream();
  return <output className="sr-only">{running ? "Dream started" : ""}</output>;
}

function DreamMenu({ className }: { className?: string }) {
  const {
    state: { running },
  } = useDream();
  if (running) {
    return <DreamingMenuButton className={className} />;
  }
  return <IdleDreamMenuButton className={className} />;
}

function IdleDreamMenuButton({ className }: { className?: string }) {
  const {
    actions: { prompt },
    state: { lastDreamedAt, pending },
  } = useDream();
  const now = useRelativeNow();
  const age = lastDreamedAt ? formatLastDreamed(lastDreamedAt, now) : "";
  const button = (
    <SidebarMenuButton
      className={cn("justify-between", className)}
      onClick={prompt}
    >
      <DreamMenuLabel>Dream</DreamMenuLabel>
      {pending > 0 ? <PendingDot /> : null}
    </SidebarMenuButton>
  );
  if (!age) {
    return button;
  }
  return <Hint label={`Last dreamed ${age}`}>{button}</Hint>;
}

// Sits in a 14px box, the same size as the row's icons, so it lines up with
// the shortcuts at the right edge of the other rows.
function PendingDot() {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <span aria-hidden className="bg-brand size-1.5 rounded-full" />
      <span className="sr-only">Needs dreaming</span>
    </span>
  );
}

function DreamingMenuButton({ className }: { className?: string }) {
  return (
    <SidebarMenuButton aria-busy className={className} disabled>
      <DreamMenuLabel>Dreaming…</DreamMenuLabel>
    </SidebarMenuButton>
  );
}

function DreamMenuLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MoonStarIcon />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function DreamConfirmDialog() {
  const {
    actions: { dismiss },
    state: { confirmOpen, ollamaRunning },
  } = useDream();
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        dismiss();
      }
    },
    [dismiss]
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={confirmOpen}>
      <DialogContent>
        {ollamaRunning ? <ConfirmDreamContent /> : <StartOllamaContent />}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDreamContent() {
  const { memoryEnabled } = useMemoryFeature();
  const {
    actions: { start },
  } = useDream();
  const onConfirm = useCallback(() => {
    start().catch(() => undefined);
  }, [start]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Start dreaming?</DialogTitle>
        <DialogDescription>
          {memoryEnabled
            ? "Sage will read new and changed journal entries and chats, then remember facts and events. Chat pauses until this finishes."
            : "Sage will index and summarize journal entries and chats, and title chats. Chat pauses until this finishes."}
        </DialogDescription>
      </DialogHeader>
      <DialogActions>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button onClick={onConfirm}>Dream</Button>
      </DialogActions>
    </>
  );
}

function StartOllamaContent() {
  const {
    actions: { startOllama },
    state: { ollamaStart },
  } = useDream();
  const starting = ollamaStart.kind === "starting";
  const description =
    ollamaStart.kind === "failed" ? ollamaStart.message : ollamaDownDreamPrompt;
  const onStart = useCallback(() => {
    startOllama().catch(() => undefined);
  }, [startOllama]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Local AI isn't running</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogActions>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button disabled={starting} onClick={onStart}>
          {starting ? <Spinner data-icon="inline-start" /> : null}
          {starting ? "Starting…" : "Start local AI"}
        </Button>
      </DialogActions>
    </>
  );
}

function DreamStatusLine() {
  const {
    state: { running },
  } = useDream();
  if (running) {
    return <DreamingCaption />;
  }
  return null;
}

function DreamingCaption() {
  const {
    state: { done, total },
  } = useDream();
  return (
    <DreamCaption>
      <span className="tabular-nums">{formatDreamProgress(done, total)}</span>
    </DreamCaption>
  );
}

function DreamCaption({ children }: { children: ReactNode }) {
  return (
    <p className="text-sidebar-foreground/70 px-2 pt-1 text-xs">{children}</p>
  );
}

function useRelativeNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, ageTickMs);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now;
}
