import { BookOpenIcon, ImportIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

function JournalWorkspace() {
  const {
    actions: { setDetailOpen },
    state: { detailOpen, expanded },
  } = useJournal();
  const isMobile = useIsMobile();
  const entriesPanelRef = usePanelRef();
  // The group stays mounted whether or not an entry is open, so the list
  // keeps its scroll position. Opening, closing, and focus mode all move one
  // number: how much of the group the list takes. The list is the one to drive
  // because the panel library will not shrink the last panel while every panel
  // before it is collapsed, which is where focus mode leaves the list.
  const [startedOpen] = useState(detailOpen);
  const detailPercentRef = useRef(defaultDetailPercent);
  const expandedRef = useRef(expanded);
  const detailOpenRef = useRef(detailOpen);
  // The detail stays on screen while it shrinks away.
  const [detailMounted, setDetailMounted] = useState(detailOpen);

  useEffect(() => {
    expandedRef.current = expanded;
    detailOpenRef.current = detailOpen;
    if (detailOpen) {
      setDetailMounted(true);
    }
  }, [detailOpen, expanded]);

  const handleSettled = useCallback(() => {
    if (!detailOpenRef.current) {
      setDetailMounted(false);
    }
  }, []);

  let entriesTarget = 100;
  if (detailOpen) {
    // Read at render so the detail opens to where the owner last left it.
    entriesTarget = expanded ? 0 : 100 - detailPercentRef.current;
  }
  const { moving, movingRef, stop } = usePanelSpring(
    entriesPanelRef,
    entriesTarget,
    handleSettled
  );

  // Remember where the owner dragged the divider, but not the sizes that a
  // move or focus mode passes through.
  const rememberDetailSize = useCallback(
    (size: { asPercentage: number; inPixels: number }) => {
      if (
        size.asPercentage > 0 &&
        !expandedRef.current &&
        !movingRef.current &&
        detailOpenRef.current
      ) {
        detailPercentRef.current = size.asPercentage;
      }
    },
    [movingRef]
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
  const minSize = moving ? "0%" : "20%";

  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={isMobile ? "vertical" : "horizontal"}
    >
      <ResizablePanel
        collapsedSize="0%"
        collapsible
        defaultSize={startedOpen ? "40%" : "100%"}
        id="journal-entries"
        minSize={minSize}
        panelRef={entriesPanelRef}
      >
        <div aria-hidden={expanded} className="h-full min-h-0" inert={expanded}>
          <EntriesColumn />
        </div>
      </ResizablePanel>
      <ResizableHandle
        className={cn((expanded || !detailOpen) && "hidden")}
        onKeyDown={stop}
        onPointerDown={stop}
      />
      <ResizablePanel
        className="overflow-hidden"
        collapsedSize="0%"
        collapsible
        defaultSize={startedOpen ? "60%" : "0%"}
        id="journal-detail"
        minSize={minSize}
        onResize={rememberDetailSize}
      >
        {detailOpen || detailMounted ? <JournalDetail /> : null}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
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
