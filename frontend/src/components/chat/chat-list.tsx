import { PencilIcon, Trash2Icon } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import type { ChatConversationMeta } from "@/bridge";
import { useRenameChat } from "@/components/chat/rename-chat-dialog";
import { useChat } from "@/components/chat-provider";
import { useJournalActions } from "@/components/journal-context";
import {
  ListEmpty,
  ListRow,
  ListRows,
  ListRowsSkeleton,
} from "@/components/list-row";
import { useCloseOnScreenHide } from "@/components/screen-active";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useAppearingIds } from "@/hooks/use-appearing-ids";
import { localDateKey } from "@/lib/format-date";
import { focusNeighborRow, isDeleteKey, isReturnKey } from "@/lib/row-keys";

/**
 * The chats in the sidebar's Chat tab. `onScreen` is false while Memories
 * fills the pane, so no row reads as the open one then.
 */
export function ChatList({ onScreen }: { onScreen: boolean }) {
  const {
    actions: { deleteConversation, openConversation, refreshList },
    state: { conversations, listFailed, listLoaded, selection },
  } = useChat();
  const {
    actions: { startRename },
  } = useRenameChat();
  const { showChat } = useJournalActions();
  // The row is current only while its chat is on screen.
  const activeId = onScreen && selection.kind === "saved" ? selection.id : null;
  const ids = useMemo(
    () => conversations.map((row) => row.id),
    [conversations]
  );
  const appearing = useAppearingIds(ids);

  useEffect(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  // From Memories, which shares the tab, a row brings Chat back first.
  const handleSelect = useCallback(
    (id: number) => {
      showChat()
        .then(() => openConversation(id))
        .catch(() => undefined);
    },
    [openConversation, showChat]
  );

  const handleRetry = useCallback(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  if (!listLoaded) {
    return <ListRowsSkeleton label="Loading chats" />;
  }

  // With no rows to show, a failed read must not look like an empty list.
  if (listFailed && conversations.length === 0) {
    return <ChatListFailed onRetry={handleRetry} />;
  }

  // The list stays mounted when the last row goes, so that row can finish
  // leaving. The empty state shows beside it.
  return (
    <>
      <ListRows label="Conversations">
        {conversations.map((row) => (
          <ChatRow
            animateIn={appearing.has(row.id)}
            key={row.id}
            onDelete={deleteConversation}
            onRename={startRename}
            onSelect={handleSelect}
            row={row}
            selected={row.id === activeId}
          />
        ))}
      </ListRows>
      {conversations.length === 0 ? (
        <ListEmpty>No conversations yet.</ListEmpty>
      ) : null}
    </>
  );
}

function ChatListFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-1.5 px-2.5 py-1.5">
      <p className="text-muted-foreground text-sm">Could not load chats.</p>
      <Button onClick={onRetry} size="xs" variant="outline">
        Try again
      </Button>
    </div>
  );
}

function ChatRowView({
  animateIn,
  row,
  selected,
  onDelete,
  onRename,
  onSelect,
}: {
  animateIn: boolean;
  row: ChatConversationMeta;
  selected: boolean;
  onDelete: (id: number) => void;
  onRename: (row: ChatConversationMeta) => void;
  onSelect: (id: number) => void;
}) {
  // Chat stays mounted while another screen shows, so the menu closes itself.
  const menuActionsRef = useCloseOnScreenHide();
  const handleClick = useCallback(() => {
    onSelect(row.id);
  }, [onSelect, row.id]);

  const handleRename = useCallback(() => {
    onRename(row);
  }, [onRename, row]);

  const handleDelete = useCallback(() => {
    onDelete(row.id);
  }, [onDelete, row.id]);

  // Return renames and ⌘⌫ deletes, as in Finder. Space still opens the chat.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isReturnKey(event)) {
        event.preventDefault();
        handleRename();
      } else if (isDeleteKey(event)) {
        event.preventDefault();
        focusNeighborRow(event.currentTarget);
        handleDelete();
      }
    },
    [handleDelete, handleRename]
  );

  return (
    <ListRow.Root actionsRef={menuActionsRef} animateIn={animateIn}>
      <ListRow.Trigger
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        selected={selected}
      >
        <ListRow.Title>{row.title}</ListRow.Title>
        {/* `updatedAt` is a UTC instant. The list shows the local day. */}
        <ListRow.Date date={localDateKey(row.updatedAt)} />
      </ListRow.Trigger>
      <ListRow.Menu>
        <ContextMenuItem onClick={handleRename}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={handleDelete} variant="destructive">
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ListRow.Menu>
    </ListRow.Root>
  );
}

const ChatRow = memo(ChatRowView);
