import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

import type { ChatConversationMeta } from "@/bridge";
import { closeReplyOverlays } from "@/components/ai-elements/message";
import { ChatDraftProvider } from "@/components/chat/chat-draft";
import { ChatList } from "@/components/chat/chat-list";
import {
  RenameChatProvider,
  useRenameChat,
} from "@/components/chat/rename-chat-dialog";
import { useChat, useChatPanel } from "@/components/chat-provider";
import { ChatScreen } from "@/components/chat-screen";
import { Hint } from "@/components/hint";
import {
  useCloseOnScreenHide,
  useOnScreenHide,
} from "@/components/screen-active";
import { SplitView, type SplitViewContextValue } from "@/components/split-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatEntryDate, localDateKey } from "@/lib/format-date";
import { shortcuts } from "@/lib/shortcuts";

/** Reply overlays sit outside Chat's layer, so hiding Chat closes them. */
function CloseReplyOverlaysOnHide() {
  useOnScreenHide(closeReplyOverlays);
  return null;
}

export function ChatLayout() {
  return (
    <ChatSplitProvider>
      <RenameChatProvider>
        <CloseReplyOverlaysOnHide />
        <ChatDraftProvider>
          {/* A reply keeps streaming and saving while the panel is closed. */}
          <SplitView.Root keepDetailMounted>
            <SplitView.List>
              <ChatListColumn />
            </SplitView.List>
            <SplitView.Detail>
              <ChatPanelHeader />
              <ChatScreen />
            </SplitView.Detail>
          </SplitView.Root>
        </ChatDraftProvider>
      </RenameChatProvider>
    </ChatSplitProvider>
  );
}

function ChatSplitProvider({ children }: { children: ReactNode }) {
  const {
    actions: { setExpanded, setPanelOpen },
    state: { expanded, panelOpen },
  } = useChatPanel();
  const value = useMemo<SplitViewContextValue>(
    () => ({
      actions: { setExpanded, setOpen: setPanelOpen },
      meta: { id: "chat" },
      state: { expanded, open: panelOpen },
    }),
    [expanded, panelOpen, setExpanded, setPanelOpen]
  );
  return <SplitView.Provider value={value}>{children}</SplitView.Provider>;
}

function ChatListColumn() {
  const {
    actions: { newChat },
  } = useChat();
  return (
    <>
      <SplitView.ListHeader title="Chat">
        <Hint label="New chat" shortcut={shortcuts.newItem}>
          <Button aria-keyshortcuts="Meta+N" onClick={newChat} size="sm">
            <PlusIcon data-icon="inline-start" />
            New chat
          </Button>
        </Hint>
      </SplitView.ListHeader>
      <SplitView.ListBody scrollKey="chat-list">
        <ChatList />
      </SplitView.ListBody>
    </>
  );
}

function ChatPanelHeader() {
  const {
    state: { conversations, selection },
  } = useChat();
  // A new chat has no row yet. A saved chat whose row has not loaded shows no
  // title rather than a wrong one.
  const row =
    selection.kind === "saved"
      ? conversations.find((candidate) => candidate.id === selection.id)
      : undefined;
  const title = selection.kind === "new" ? "New chat" : (row?.title ?? "");
  return (
    <SplitView.DetailHeader>
      <SplitView.PanelControls
        backLabel="Back to chats"
        closeLabel="Close chat"
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-3 text-sm">
        <h2 className="min-w-0 truncate font-medium">{title}</h2>
        {row ? <ChatDate updatedAt={row.updatedAt} /> : null}
      </div>
      {row ? <ChatMenu row={row} /> : null}
    </SplitView.DetailHeader>
  );
}

/** `updatedAt` is a UTC instant. The header shows the local day. */
function ChatDate({ updatedAt }: { updatedAt: string }) {
  const day = localDateKey(updatedAt);
  // The date gives way before the title does when the panel is narrow.
  return (
    <time
      className="min-w-0 shrink-[4] truncate text-muted-foreground"
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
