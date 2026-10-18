import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

import type { ChatConversationMeta } from "@/bridge";
import { ChatList } from "@/components/chat/chat-list";
import {
  RenameChatProvider,
  useRenameChat,
} from "@/components/chat/rename-chat-dialog";
import { useChat } from "@/components/chat-provider";
import { ChatScreen } from "@/components/chat-screen";
import { Hint } from "@/components/hint";
import { SplitView, type SplitViewContextValue } from "@/components/split-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortcuts } from "@/lib/shortcuts";

export function ChatLayout() {
  return (
    <ChatSplitProvider>
      <RenameChatProvider>
        <SplitView.Root>
          <SplitView.List>
            <ChatListColumn />
          </SplitView.List>
          <SplitView.Detail>
            <ChatPanelHeader />
            <ChatScreen />
          </SplitView.Detail>
        </SplitView.Root>
      </RenameChatProvider>
    </ChatSplitProvider>
  );
}

function ChatSplitProvider({ children }: { children: ReactNode }) {
  const {
    actions: { setExpanded, setPanelOpen },
    state: { expanded, panelOpen },
  } = useChat();
  // Full screen is kept while you visit other screens. It ends when the panel
  // closes.
  const setOpen = useCallback(
    (open: boolean) => {
      setPanelOpen(open);
      if (!open) {
        setExpanded(false);
      }
    },
    [setExpanded, setPanelOpen]
  );
  const value = useMemo<SplitViewContextValue>(
    () => ({
      actions: { setExpanded, setOpen },
      meta: { id: "chat" },
      state: { expanded, open: panelOpen },
    }),
    [expanded, panelOpen, setExpanded, setOpen]
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
      <h2 className="min-w-0 flex-1 truncate font-medium text-sm">{title}</h2>
      {row ? <ChatMenu row={row} /> : null}
    </SplitView.DetailHeader>
  );
}

function ChatMenu({ row }: { row: ChatConversationMeta }) {
  const {
    actions: { deleteConversation },
  } = useChat();
  const {
    actions: { startRename },
  } = useRenameChat();
  const handleRename = useCallback(() => {
    startRename(row);
  }, [row, startRename]);
  const handleDelete = useCallback(() => {
    deleteConversation(row.id);
  }, [deleteConversation, row.id]);
  return (
    <DropdownMenu>
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
