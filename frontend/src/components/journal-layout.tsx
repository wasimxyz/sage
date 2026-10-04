import { BookOpenIcon, ImportIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { DeleteEntryDialog } from "@/components/delete-entry-dialog";
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
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { pageColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

const collapsedLeadingClass = "pl-[calc(var(--titlebar-leading)+2.75rem)]";

export function JournalLayout() {
  return (
    <>
      <JournalWorkspace />
      <DeleteEntryDialog />
    </>
  );
}

function JournalWorkspace() {
  const {
    actions: { setDetailOpen },
    state: { detailOpen, expanded },
  } = useJournal();
  const isMobile = useIsMobile();
  const entriesPanelRef = usePanelRef();

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

  useEffect(() => {
    if (!detailOpen) {
      return;
    }
    const panel = entriesPanelRef.current;
    if (!panel) {
      return;
    }
    if (expanded) {
      panel.collapse();
      return;
    }
    if (panel.isCollapsed()) {
      panel.expand();
    }
  }, [detailOpen, entriesPanelRef, expanded]);

  if (!detailOpen) {
    return <EntriesColumn />;
  }

  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={isMobile ? "vertical" : "horizontal"}
    >
      <ResizablePanel
        collapsedSize="0%"
        collapsible
        defaultSize="40%"
        id="journal-entries"
        minSize="20%"
        panelRef={entriesPanelRef}
      >
        <div aria-hidden={expanded} className="h-full min-h-0" inert={expanded}>
          <EntriesColumn />
        </div>
      </ResizablePanel>
      <ResizableHandle className={cn(expanded && "hidden")} />
      <ResizablePanel defaultSize="60%" id="journal-detail" minSize="20%">
        <JournalDetail />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function JournalDetail() {
  const { open } = useSidebar();
  const {
    state: { expanded, selection },
  } = useJournal();
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        !open && expanded && collapsedLeadingClass
      )}
    >
      {selection ? <EditorPane /> : <SelectEntryEmpty />}
    </div>
  );
}

function EntriesColumn() {
  const {
    actions: { select, startDraft },
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
          <h2 className="ml-3 min-w-0 truncate font-medium text-base">
            Journal
          </h2>
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
        <div className={cn(pageColumnClass, "pt-2 pb-4")}>
          <EntriesList
            entries={entries}
            loading={loadingList}
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
