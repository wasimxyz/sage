import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback } from "react";

import type { ChatConversationMeta } from "@/bridge";
import { closeReplyOverlays } from "@/components/ai-elements/message";
import { ChatDraftProvider } from "@/components/chat/chat-draft";
import { useRenameChat } from "@/components/chat/rename-chat-dialog";
import { useChat } from "@/components/chat-provider";
import { ChatScreen } from "@/components/chat-screen";
import { PaneHeader } from "@/components/pane-header";
import {
  useCloseOnScreenHide,
  useOnScreenHide,
} from "@/components/screen-active";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatEntryDate, localDateKey } from "@/lib/format-date";

/** Reply overlays sit outside Chat's layer, so hiding Chat closes them. */
function CloseReplyOverlaysOnHide() {
  useOnScreenHide(closeReplyOverlays);
  return null;
}

/**
 * The Chat tab's pane: the open chat, or a new one. The chat list is in the
 * sidebar.
 */
export function ChatLayout() {
  return (
    <ChatDraftProvider>
      <CloseReplyOverlaysOnHide />
      <ChatPaneHeader />
      <ChatScreen />
    </ChatDraftProvider>
  );
}

function ChatPaneHeader() {
  const {
    state: { conversations, selection },
  } = useChat();
  // A new chat has no row yet, and its pane shows only the greeting. A saved
  // chat whose row has not loaded shows no title rather than a wrong one.
  const row =
    selection.kind === "saved"
      ? conversations.find((candidate) => candidate.id === selection.id)
      : undefined;
  return (
    <PaneHeader>
      {row ? (
        <>
          <div className="flex min-w-0 flex-1 items-baseline gap-3 text-sm">
            <h2 className="min-w-0 truncate font-medium">{row.title}</h2>
            <ChatDate updatedAt={row.updatedAt} />
          </div>
          <ChatMenu row={row} />
        </>
      ) : null}
    </PaneHeader>
  );
}

/** `updatedAt` is a UTC instant. The header shows the local day. */
function ChatDate({ updatedAt }: { updatedAt: string }) {
  const day = localDateKey(updatedAt);
  // The date gives way before the title does when the pane is narrow.
  return (
    <time
      className="text-muted-foreground min-w-0 shrink-[4] truncate"
      dateTime={day}
    >
      {formatEntryDate(day)}
    </time>
  );
}

function ChatMenu({ row }: { row: ChatConversationMeta }) {
  const {
    actions: { deleteConversation },
  } = useChat();
  const {
    actions: { startRename },
  } = useRenameChat();
  const actionsRef = useCloseOnScreenHide();
  const handleRename = useCallback(() => {
    startRename(row);
  }, [row, startRename]);
  const handleDelete = useCallback(() => {
    deleteConversation(row.id);
  }, [deleteConversation, row.id]);
  return (
    <DropdownMenu actionsRef={actionsRef}>
      <DropdownMenuTrigger
        render={
          <Button aria-label="Chat actions" size="icon-sm" variant="ghost" />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={handleRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDelete} variant="destructive">
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
