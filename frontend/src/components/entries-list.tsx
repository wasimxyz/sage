import { BookOpenIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useMemo } from "react";
import type { JournalEntryMeta } from "@/bridge";
import { ListRow, ListRows, ListRowsSkeleton } from "@/components/list-row";
import { ContextMenuItem } from "@/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAppearingIds } from "@/hooks/use-appearing-ids";
import { focusNeighborRow, isDeleteKey } from "@/lib/row-keys";

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
    return <ListRowsSkeleton label="Loading journal entries" />;
  }

  // The list stays mounted when the last row goes, so that row can finish
  // leaving. The empty state shows beside it.
  return (
    <>
      <ListRows label="Journal entries">
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
      </ListRows>
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
    <ListRow.Root animateIn={animateIn}>
      <ListRow.Trigger
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        selected={selected}
      >
        <ListRow.Title>{entry.title}</ListRow.Title>
        <ListRow.Date date={entry.date} />
      </ListRow.Trigger>
      <ListRow.Menu>
        <ContextMenuItem onClick={handleDelete} variant="destructive">
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ListRow.Menu>
    </ListRow.Root>
  );
}

// Memoized: typing in the open entry changes the title and save label many
// times a second, and none of that should touch the rest of the list.
const EntryRow = memo(EntryRowView);
