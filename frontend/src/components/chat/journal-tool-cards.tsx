"use client";

import { Fragment, useCallback, useMemo } from "react";

import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { useJournal } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  type JournalBodyContent,
  type JournalToolEntry,
  type JournalToolSearchHit,
  journalEntryPreview,
} from "@/lib/chat/journal-tool-output";
import { formatEntryDate } from "@/lib/format-date";
import { oneLinePlainText } from "@/lib/journal-plain-text";

const toolHeaderClassName = "h-8 w-full justify-start";

// A card opens its entry in the expanded editor, not beside the list.
function useOpenEntryExpanded(id: number) {
  const {
    actions: { select, setExpanded },
  } = useJournal();
  return useCallback(async () => {
    await select(id);
    setExpanded(true);
  }, [id, select, setExpanded]);
}

export function JournalSearchToolCard({
  query,
  hits,
}: {
  query: string;
  hits: JournalToolSearchHit[];
}) {
  return (
    <Tool data-tool-name="search_journal" data-tool-state="output-available">
      <ToolHeader
        className={toolHeaderClassName}
        state="output-available"
        title="Searched the journal"
        toolName="search_journal"
      >
        <span className="min-w-0 truncate">Searched journal for “{query}”</span>
      </ToolHeader>
      <ToolContent className="border-0 bg-transparent p-0 text-foreground">
        {hits.length === 0 ? (
          <Empty className="min-h-24 gap-2 rounded-2xl border border-input border-solid bg-surface p-5">
            <EmptyHeader>
              <EmptyTitle className="text-muted-foreground">
                No matching entries
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-input bg-surface">
            {hits.map((hit, index) => (
              <Fragment key={hit.id}>
                {index > 0 ? <Separator /> : null}
                <JournalSearchRow hit={hit} />
              </Fragment>
            ))}
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}

function JournalSearchRow({ hit }: { hit: JournalToolSearchHit }) {
  const date = formatEntryDate(hit.date);
  const snippet = oneLinePlainText(hit.snippet);
  const openEntry = useOpenEntryExpanded(hit.id);

  return (
    <Button
      aria-label={`Open journal entry: ${hit.title}, ${date}`}
      className="h-auto w-full justify-between gap-3 rounded-none px-4 py-2.5 text-left text-muted-foreground"
      data-entry-id={hit.id}
      onClick={openEntry}
      type="button"
      variant="ghost"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-foreground">{hit.title}</span>
          <time className="shrink-0" dateTime={hit.date}>
            {date}
          </time>
        </span>
        <span className="line-clamp-1">{snippet}</span>
      </span>
    </Button>
  );
}

export function JournalEntryToolCard({
  bodyContent,
  entry,
}: {
  bodyContent: JournalBodyContent;
  entry: JournalToolEntry;
}) {
  return (
    <Tool
      className="mb-0"
      data-entry-id={entry.id}
      data-tool-name="get_journal_entry"
      data-tool-state="output-available"
    >
      <ToolHeader
        className={toolHeaderClassName}
        state="output-available"
        title={`Read “${entry.title}”`}
        toolName="get_journal_entry"
      >
        <span className="min-w-0 truncate">Read “{entry.title}”</span>
      </ToolHeader>
      <ToolContent className="p-0">
        <JournalEntryPreview bodyContent={bodyContent} entry={entry} />
      </ToolContent>
    </Tool>
  );
}

function JournalEntryPreview({
  bodyContent,
  entry,
}: {
  bodyContent: JournalBodyContent;
  entry: JournalToolEntry;
}) {
  const { kind, text } = bodyContent;
  const preview = useMemo(
    () => journalEntryPreview({ kind, text }),
    [kind, text]
  );
  const openEntry = useOpenEntryExpanded(entry.id);

  return (
    <Button
      aria-label={`Open journal entry: ${entry.title}, ${formatEntryDate(entry.date)}`}
      className="h-auto w-full justify-start whitespace-normal rounded-none px-4 py-3 text-left font-normal text-muted-foreground text-xs"
      onClick={openEntry}
      type="button"
      variant="ghost"
    >
      {preview.length > 0 ? preview : "This entry is empty."}
    </Button>
  );
}
