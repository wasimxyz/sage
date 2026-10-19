import { BookOpenIcon, ImportIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import EditorPane from "@/components/editor";
import { EntriesList } from "@/components/entries-list";
import { useFileMenu } from "@/components/file-menu-provider";
import { Hint } from "@/components/hint";
import {
  useJournalActions,
  useJournalEntries,
  useJournalView,
} from "@/components/journal-context";
import { SplitView, type SplitViewContextValue } from "@/components/split-view";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { shortcuts } from "@/lib/shortcuts";

export function JournalLayout() {
  return (
    <JournalSplitProvider>
      <SplitView.Root>
        <SplitView.List>
          <EntriesColumn />
        </SplitView.List>
        <SplitView.Detail>
          <JournalDetail />
        </SplitView.Detail>
      </SplitView.Root>
    </JournalSplitProvider>
  );
}

function JournalSplitProvider({ children }: { children: ReactNode }) {
  const { setDetailOpen, setExpanded } = useJournalActions();
  const { detailOpen, expanded } = useJournalView();
  const value = useMemo<SplitViewContextValue>(
    () => ({
      actions: { setExpanded, setOpen: setDetailOpen },
      meta: { id: "journal" },
      state: { expanded, open: detailOpen },
    }),
    [detailOpen, expanded, setDetailOpen, setExpanded]
  );
  return <SplitView.Provider value={value}>{children}</SplitView.Provider>;
}

function JournalDetail() {
  const { selection } = useJournalView();
  return selection ? <EditorPane /> : <SelectEntryEmpty />;
}

function EntriesColumn() {
  const { deleteEntry, select, startDraft } = useJournalActions();
  const { entries, loadingList } = useJournalEntries();
  const { selectedId } = useJournalView();
  return (
    <>
      <SplitView.ListHeader title="Journal">
        <ImportButton />
        <Button aria-keyshortcuts="Meta+N" onClick={startDraft} size="sm">
          <PlusIcon data-icon="inline-start" />
          New entry
        </Button>
      </SplitView.ListHeader>
      <SplitView.ListBody scrollKey="journal-list">
        <EntriesList
          entries={entries}
          loading={loadingList}
          onDelete={deleteEntry}
          onSelect={select}
          selectedId={selectedId}
        />
      </SplitView.ListBody>
    </>
  );
}

function ImportButton() {
  const {
    actions: { openImport },
  } = useFileMenu();
  return (
    <Hint label="Import" shortcut={shortcuts.import}>
      <Button
        aria-label="Import"
        onClick={openImport}
        size="icon-sm"
        variant="ghost"
      >
        <ImportIcon className="size-4.25" />
      </Button>
    </Hint>
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
