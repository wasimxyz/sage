import { BookOpenIcon, ImportIcon, PlusIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePanelRef } from "react-resizable-panels";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import EditorPane from "@/components/editor";
import { EntriesList } from "@/components/entries-list";
import { useFileMenu } from "@/components/file-menu-provider";
import { useJournal } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePanelSpring } from "@/hooks/use-panel-spring";
import { useRememberedScroll } from "@/hooks/use-remembered-scroll";
import { pageColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

// Focus mode puts the editor under the titlebar toggle. The padding follows
// the sidebar's slide, full when it is closed and none when it is open.
const collapsedLeadingClass =
  "pl-[calc((var(--titlebar-leading)+2.75rem)*(1-var(--sidebar-progress,1)))]";

export function JournalLayout() {
  return <JournalWorkspace />;
}

const defaultDetailPercent = 60;
// The detail never remembers a size outside this range. Dragging the divider
// to an edge would otherwise reopen the next entry with the list hidden.
const minRememberedPercent = 20;
const maxRememberedPercent = 80;
// The keys that move the divider. Tab passing over it must not stop a move.
const dividerKeys = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Enter",
  "Home",
]);

type LayoutStep = "closed" | "focus" | "open";

function JournalWorkspace() {
  const {
    actions: { setDetailOpen },
    state: { detailOpen, expanded },
  } = useJournal();
  const isMobile = useIsMobile();
  const entriesPanelRef = usePanelRef();
  // The group stays mounted whether or not an entry is open, so the list
  // keeps its place. Opening, closing, and focus mode all move one number:
  // how much of the group the list takes. The list is the one to drive
  // because the panel library will not shrink the last panel while every panel
  // before it is collapsed, which is where focus mode leaves the list.
  const step: LayoutStep = layoutStep(detailOpen, expanded);
  const [startedAt] = useState<LayoutStep>(step);
  const [settledStep, setSettledStep] = useState<LayoutStep>(step);
  const detailPercentRef = useRef(defaultDetailPercent);
  const expandedRef = useRef(expanded);
  const detailOpenRef = useRef(detailOpen);
  // The detail stays on screen while it shrinks away.
  const [detailMounted, setDetailMounted] = useState(detailOpen);
  if (detailOpen && !detailMounted) {
    setDetailMounted(true);
  }

  useEffect(() => {
    expandedRef.current = expanded;
    detailOpenRef.current = detailOpen;
  }, [detailOpen, expanded]);

  const handleSettled = useCallback((reached: string) => {
    setSettledStep(reached as LayoutStep);
    if (reached === "closed") {
      setDetailMounted(false);
    }
  }, []);

  const { moving, movingRef, stop } = usePanelSpring(
    entriesPanelRef,
    step,
    () => {
      if (step === "closed") {
        return 100;
      }
      // Read when the move starts, so the detail opens to where the owner
      // last left it.
      return step === "focus" ? 0 : 100 - detailPercentRef.current;
    },
    handleSettled
  );

  // Remember where the owner dragged the divider, but not the sizes that a
  // move or focus mode passes through.
  const rememberDetailSize = useCallback(
    (size: { asPercentage: number; inPixels: number }) => {
      if (
        size.asPercentage >= minRememberedPercent &&
        size.asPercentage <= maxRememberedPercent &&
        !expandedRef.current &&
        !movingRef.current &&
        detailOpenRef.current
      ) {
        detailPercentRef.current = size.asPercentage;
      }
    },
    [movingRef]
  );

  // Double-clicking the divider puts the split back to its usual size. The
  // library's own reset goes to the first panel's default, which is the whole
  // group when the Journal opened with no entry.
  const resetSplit = useCallback(() => {
    if (step === "open" && !moving) {
      entriesPanelRef.current?.resize(`${100 - defaultDetailPercent}%`);
    }
  }, [entriesPanelRef, moving, step]);

  const handleDividerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (dividerKeys.has(event.key)) {
        stop();
      }
    },
    [stop]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.code !== "KeyB" ||
        !(event.metaKey || event.ctrlKey) ||
        !event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      setDetailOpen(!detailOpen);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [detailOpen, setDetailOpen]);

  // Panels with a minimum snap to it, or to collapsed, on any size below it.
  // A move passes through those sizes, so the minimum is off while it runs.
  // The detail is not collapsible, so an open one cannot be dragged away and
  // the divider keeps working from the keyboard. It has a minimum only once
  // it has settled open, and none while closed.
  const entriesMinSize = moving ? "0%" : "20%";
  const detailMinSize =
    !moving && step === "open" && settledStep === "open" ? "20%" : "0%";

  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={isMobile ? "vertical" : "horizontal"}
    >
      <ResizablePanel
        collapsedSize="0%"
        collapsible
        defaultSize={startedAt === "open" ? "40%" : "100%"}
        id="journal-entries"
        minSize={entriesMinSize}
        panelRef={entriesPanelRef}
      >
        <div aria-hidden={expanded} className="h-full min-h-0" inert={expanded}>
          <EntriesColumn />
        </div>
      </ResizablePanel>
      <ResizableHandle
        className={cn((expanded || !detailOpen) && "hidden")}
        disableDoubleClick
        onDoubleClick={resetSplit}
        onKeyDown={handleDividerKeyDown}
        onPointerDown={stop}
      />
      <ResizablePanel
        className="overflow-hidden"
        defaultSize={startedAt === "open" ? "60%" : "0%"}
        id="journal-detail"
        minSize={detailMinSize}
        onResize={rememberDetailSize}
      >
        {detailOpen || detailMounted ? <JournalDetail /> : null}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function layoutStep(detailOpen: boolean, expanded: boolean): LayoutStep {
  if (!detailOpen) {
    return "closed";
  }
  return expanded ? "focus" : "open";
}

function JournalDetail() {
  const {
    state: { expanded, selection },
  } = useJournal();
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        expanded && collapsedLeadingClass
      )}
    >
      {selection ? <EditorPane /> : <SelectEntryEmpty />}
    </div>
  );
}

function EntriesColumn() {
  const listRef = useRememberedScroll<HTMLDivElement>("journal-list");
  const {
    actions: { deleteEntry, select, startDraft },
    state: { entries, loadingList, selectedId },
  } = useJournal();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="shrink-0 pt-(--titlebar-height) pb-1"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      >
        <div
          className={cn(
            pageColumnClass,
            "flex h-8 items-center justify-between gap-2"
          )}
        >
          <h1 className="ml-3 min-w-0 truncate font-medium text-base">
            Journal
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <ImportButton />
            <Button onClick={startDraft} size="sm">
              <PlusIcon data-icon="inline-start" />
              New entry
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(pageColumnClass, "pt-2 pb-4")} ref={listRef}>
          <EntriesList
            entries={entries}
            loading={loadingList}
            onDelete={deleteEntry}
            onSelect={select}
            selectedId={selectedId}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function ImportButton() {
  const {
    actions: { openImport },
  } = useFileMenu();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Import"
            onClick={openImport}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <ImportIcon className="size-4.25" />
      </TooltipTrigger>
      <TooltipContent>Import</TooltipContent>
    </Tooltip>
  );
}

function SelectEntryEmpty() {
  return (
    <div className="flex h-full min-h-0">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpenIcon />
          </EmptyMedia>
          <EmptyTitle>Select an entry</EmptyTitle>
          <EmptyDescription>
            Open a row to read and edit it, or write a new one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
