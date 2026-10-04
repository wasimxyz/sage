import { BookOpenIcon, Trash2Icon } from "lucide-react";
import { useCallback } from "react";
import type { JournalEntryMeta } from "@/bridge";
import { useEntry } from "@/components/journal-context";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { formatJournalListDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";

const skeletonRows = [0, 1, 2, 3, 4];
const rowClassName =
  "flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50";

export function EntriesList({
  entries,
  selectedId,
  loading,
  onSelect,
}: {
  entries: JournalEntryMeta[];
  selectedId: number | null;
  loading: boolean;
  onSelect: (id: number) => void;
}) {
  if (loading) {
    return (
      <div role="status">
        <span className="sr-only">Loading journal entries</span>
        {skeletonRows.map((row) => (
          <div
            className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5"
            key={row}
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpenIcon />
          </EmptyMedia>
          <EmptyTitle>No journal entries</EmptyTitle>
          <EmptyDescription>Write a new entry to get started.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul aria-label="Journal entries" className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <EntryRow
          entry={entry}
          key={entry.id}
          onSelect={onSelect}
          selected={entry.id === selectedId}
        />
      ))}
    </ul>
  );
}

function EntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: JournalEntryMeta;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const {
    actions: { openDeleteEntry },
  } = useEntry();
  const handleClick = useCallback(() => {
    onSelect(entry.id);
  }, [entry.id, onSelect]);

  const handleDelete = useCallback(() => {
    openDeleteEntry(entry.id);
  }, [entry.id, openDeleteEntry]);

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              aria-current={selected ? "true" : undefined}
              className={cn(
                rowClassName,
                selected && "bg-foreground/10 hover:bg-foreground/10"
              )}
              onClick={handleClick}
              type="button"
            />
          }
        >
          <span className="min-w-0 truncate font-medium">{entry.title}</span>
          <time
            className="shrink-0 text-muted-foreground"
            dateTime={entry.date}
          >
            {formatJournalListDate(entry.date)}
          </time>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem onClick={handleDelete} variant="destructive">
              <Trash2Icon />
              Delete
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
