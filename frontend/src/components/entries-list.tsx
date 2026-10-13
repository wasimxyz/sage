import { BookOpenIcon, Trash2Icon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { type KeyboardEvent, memo, useCallback, useMemo } from "react";
import type { JournalEntryMeta } from "@/bridge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuShortcut,
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
import { useAppearingIds } from "@/hooks/use-appearing-ids";
import { formatJournalListDate } from "@/lib/format-date";
import { spring } from "@/lib/motion";
import { focusNeighborRow, isDeleteKey } from "@/lib/row-keys";
import { cn } from "@/lib/utils";

const skeletonRows = [0, 1, 2, 3, 4];
// Rows clip while they grow or shrink, and not at rest, so the focus ring
// that sits outside a row is not cut off.
const rowClosed = { height: 0, opacity: 0, overflow: "hidden" } as const;
const rowOpen = {
  height: "auto",
  opacity: 1,
  overflow: "hidden",
  transitionEnd: { overflow: "visible" },
} as const;
const rowClassName =
  "flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/15 active:duration-0";

export function EntriesList({
  entries,
  selectedId,
  loading,
  onDelete,
  onSelect,
}: {
  entries: JournalEntryMeta[];
  selectedId: number | null;
  loading: boolean;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const appearing = useAppearingIds(ids);
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

  // The list stays mounted when the last row goes, so that row can finish
  // leaving. The empty state shows beside it.
  return (
    <>
      <ul aria-label="Journal entries" className="flex flex-col">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <EntryRow
              animateIn={appearing.has(entry.id)}
              entry={entry}
              key={entry.id}
              onDelete={onDelete}
              onSelect={onSelect}
              selected={entry.id === selectedId}
            />
          ))}
        </AnimatePresence>
      </ul>
      {entries.length === 0 ? (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No journal entries</EmptyTitle>
            <EmptyDescription>
              Write a new entry to get started.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}

function EntryRowView({
  animateIn,
  entry,
  selected,
  onDelete,
  onSelect,
}: {
  animateIn: boolean;
  entry: JournalEntryMeta;
  selected: boolean;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const handleClick = useCallback(() => {
    onSelect(entry.id);
  }, [entry.id, onSelect]);

  const handleDelete = useCallback(() => {
    onDelete(entry.id);
  }, [entry.id, onDelete]);

  // ⌘⌫ deletes, as in Finder. Focus moves to a neighboring row first.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isDeleteKey(event)) {
        event.preventDefault();
        focusNeighborRow(event.currentTarget);
        onDelete(entry.id);
      }
    },
    [entry.id, onDelete]
  );

  return (
    <m.li
      animate={rowOpen}
      exit={rowClosed}
      initial={animateIn ? rowClosed : false}
      transition={spring}
    >
      {/* The gap between rows lives inside, so the row can shrink to nothing. */}
      <div className="pb-0.5">
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
                onKeyDown={handleKeyDown}
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
                <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </m.li>
  );
}

// Memoized: typing in the open entry changes the title and save label many
// times a second, and none of that should touch the rest of the list.
const EntryRow = memo(EntryRowView);
