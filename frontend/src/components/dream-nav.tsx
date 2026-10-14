import { MoonStarIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { useDream } from "@/components/dream-provider";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { SearchNavItem } from "@/components/search-dialog";
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
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ollamaDownDreamPrompt } from "@/lib/dream-errors";
import { formatDreamProgress } from "@/lib/dream-progress";
import { formatLastDreamed } from "@/lib/format-relative-age";

const ageTickMs = 60_000;

export function DreamNav() {
  return (
    <>
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SearchNavItem />
            <SidebarMenuItem>
              <DreamMenu />
            </SidebarMenuItem>
          </SidebarMenu>
          <DreamStatusLine />
        </SidebarGroupContent>
      </SidebarGroup>
    </>
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

function DreamMenu() {
  const {
    state: { running },
  } = useDream();
  if (running) {
    return <DreamingMenuButton />;
  }
  return <IdleDreamMenuButton />;
}

function IdleDreamMenuButton() {
  const {
    actions: { prompt },
  } = useDream();
  return (
    <SidebarMenuButton onClick={prompt} tooltip="Dream">
      <DreamMenuLabel>Dream</DreamMenuLabel>
    </SidebarMenuButton>
  );
}

function DreamingMenuButton() {
  return (
    <SidebarMenuButton aria-busy disabled>
      <DreamMenuLabel>Dreaming…</DreamMenuLabel>
    </SidebarMenuButton>
  );
}

function DreamMenuLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <MoonStarIcon />
      <span>{children}</span>
    </>
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
            : "Sage will index journal entries, update their summaries, and title chats. Chat pauses until this finishes."}
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
        <DialogTitle>Ollama isn't running</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogActions>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button disabled={starting} onClick={onStart}>
          {starting ? <Spinner data-icon="inline-start" /> : null}
          {starting ? "Starting…" : "Start Ollama"}
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
  return <LastDreamedCaption />;
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

function LastDreamedCaption() {
  const {
    state: { lastDreamedAt },
  } = useDream();
  const now = useRelativeNow();
  if (!lastDreamedAt) {
    return null;
  }
  const age = formatLastDreamed(lastDreamedAt, now);
  if (!age) {
    return null;
  }
  return <DreamCaption>Last dreamed {age}</DreamCaption>;
}

function DreamCaption({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1 text-sidebar-foreground/70 text-xs">{children}</p>
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
