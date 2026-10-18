import {
  AlertCircleIcon,
  MessageCircleIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import type { ChatConversationMeta } from "@/bridge";
import { useRenameChat } from "@/components/chat/rename-chat-dialog";
import { useChat, useChatPanel } from "@/components/chat-provider";
import { ListRow, ListRows, ListRowsSkeleton } from "@/components/list-row";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAppearingIds } from "@/hooks/use-appearing-ids";
import { localDateKey } from "@/lib/format-date";
import { focusNeighborRow, isDeleteKey, isReturnKey } from "@/lib/row-keys";

export function ChatList() {
  const {
    actions: { deleteConversation, openConversation, refreshList },
    state: { conversations, listFailed, listLoaded, selection },
  } = useChat();
  const {
    state: { panelOpen },
  } = useChatPanel();
  const {
    actions: { startRename },
  } = useRenameChat();
  // The row is current only while its chat is on screen.
  const activeId =
    panelOpen && selection.kind === "saved" ? selection.id : null;
  const ids = useMemo(
    () => conversations.map((row) => row.id),
    [conversations]
  );
  const appearing = useAppearingIds(ids);

  useEffect(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  const handleSelect = useCallback(
    (id: number) => {
      openConversation(id);
    },
    [openConversation]
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
      <ListRows label="Chats">
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
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageCircleIcon />
            </EmptyMedia>
            <EmptyTitle>No chats yet</EmptyTitle>
            <EmptyDescription>
              Start a new chat to talk through your thoughts.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}

function ChatListFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon />
        </EmptyMedia>
        <EmptyTitle>Could not load chats</EmptyTitle>
        <EmptyDescription>Sage could not read your chats.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRetry} size="sm" variant="outline">
          Try again
        </Button>
      </EmptyContent>
    </Empty>
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
    <ListRow.Root animateIn={animateIn}>
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
