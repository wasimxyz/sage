import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { ChatConversationMeta } from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { useJournalActions } from "@/components/journal-context";
import { SearchNavItem } from "@/components/search-dialog";
import { SidebarBackButton } from "@/components/sidebar-back-button";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppearingIds } from "@/hooks/use-appearing-ids";
import { formatRelativeAge } from "@/lib/format-relative-age";
import { spring } from "@/lib/motion";
import { focusNeighborRow, isDeleteKey, isReturnKey } from "@/lib/row-keys";

const ageTickMs = 60_000;
const titleLimit = 60;
// Rows clip while they grow or shrink, and not at rest, so the focus ring is
// not cut off.
const rowClosed = { height: 0, opacity: 0, overflow: "hidden" } as const;
const rowOpen = {
  height: "auto",
  opacity: 1,
  overflow: "hidden",
  transitionEnd: { overflow: "visible" },
} as const;
/** A row that arrives on its own grows in. Rows that arrive in a batch do not. */
function initialRow(animateIn: boolean) {
  return animateIn ? rowClosed : false;
}

const conversationItemClass =
  "justify-between [&>span:last-child]:overflow-visible [content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]";

export function ConversationsMenu() {
  const {
    actions: { refreshList },
    state: { conversations, selection },
  } = useChat();
  const now = useRelativeNow();
  const activeId = selection.kind === "saved" ? selection.id : null;
  const [renaming, setRenaming] = useState<ChatConversationMeta | null>(null);
  const ids = useMemo(
    () => conversations.map((row) => row.id),
    [conversations]
  );
  const appearing = useAppearingIds(ids);

  useEffect(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRenaming(null);
    }
  }, []);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <ConversationsBackButton />
            <NewChatButton />
            <SearchNavItem />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="pt-0">
        <SidebarGroupLabel>Conversations</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu className="gap-0">
            {conversations.length === 0 ? (
              <SidebarMenuItem>
                <span className="px-2 py-1.5 text-muted-foreground text-sm">
                  No saved chats
                </span>
              </SidebarMenuItem>
            ) : null}
            <AnimatePresence initial={false}>
              {conversations.map((row) => (
                <ConversationItem
                  active={row.id === activeId}
                  animateIn={appearing.has(row.id)}
                  key={row.id}
                  now={now}
                  onRename={setRenaming}
                  row={row}
                />
              ))}
            </AnimatePresence>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {renaming ? (
        <RenameConversationDialog
          key={renaming.id}
          onOpenChange={handleDialogOpenChange}
          row={renaming}
        />
      ) : null}
    </>
  );
}

function NewChatButton() {
  const {
    actions: { newChat },
    state: { selection },
  } = useChat();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+N"
        isActive={selection.kind === "new"}
        onClick={newChat}
      >
        <PlusIcon />
        <span>New chat</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ConversationsBackButton() {
  const { showJournal } = useJournalActions();
  return <SidebarBackButton onClick={showJournal} />;
}

function ConversationItem({
  active,
  animateIn,
  now,
  row,
  onRename: onRenameRow,
}: {
  active: boolean;
  animateIn: boolean;
  now: number;
  row: ChatConversationMeta;
  onRename: (row: ChatConversationMeta) => void;
}) {
  const {
    actions: { deleteConversation, openConversation },
  } = useChat();
  // A row that is leaving cannot take focus, and neighbors skip it.
  const isPresent = useIsPresent();
  const onClick = useCallback(() => {
    openConversation(row.id);
  }, [openConversation, row.id]);
  const onRename = useCallback(() => {
    onRenameRow(row);
  }, [onRenameRow, row]);
  const onDelete = useCallback(() => {
    deleteConversation(row.id);
  }, [deleteConversation, row.id]);
  // Return renames and ⌘⌫ deletes, as in Finder. Space still opens the chat.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isReturnKey(event)) {
        event.preventDefault();
        onRename();
      } else if (isDeleteKey(event)) {
        event.preventDefault();
        focusNeighborRow(event.currentTarget);
        onDelete();
      }
    },
    [onDelete, onRename]
  );
  return (
    // The same markers as SidebarMenuItem, as a motion element. The gap between
    // rows lives inside, so a row can shrink to nothing as it leaves.
    <m.li
      animate={rowOpen}
      className="group/menu-item relative"
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      exit={rowClosed}
      inert={!isPresent}
      initial={initialRow(animateIn)}
      transition={spring}
    >
      <div className="pb-1">
        <Tooltip>
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-keyshortcuts="Meta+Backspace"
                      className={conversationItemClass}
                      isActive={active}
                      onClick={onClick}
                      onKeyDown={onKeyDown}
                    />
                  }
                />
              }
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatRelativeAge(row.updatedAt, now)}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuItem onClick={onRename}>
                  <PencilIcon />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem onClick={onDelete} variant="destructive">
                  <Trash2Icon />
                  Delete
                </ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
          <TooltipContent side="right">{row.title}</TooltipContent>
        </Tooltip>
      </div>
    </m.li>
  );
}

function RenameConversationDialog({
  onOpenChange,
  row,
}: {
  onOpenChange: (open: boolean) => void;
  row: ChatConversationMeta;
}) {
  const {
    actions: { renameConversation },
  } = useChat();
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState(false);

  const trimmed = title.trim();
  const canSave = trimmed.length > 0 && trimmed !== row.title && !busy;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      onOpenChange(open);
    },
    [busy, onOpenChange]
  );

  const submit = useCallback(async () => {
    if (!canSave) {
      return;
    }
    setBusy(true);
    try {
      await renameConversation(row.id, trimmed);
      onOpenChange(false);
    } catch {
      setBusy(false);
    }
  }, [canSave, onOpenChange, renameConversation, row.id, trimmed]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit().catch(() => undefined);
    },
    [submit]
  );

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTitle(event.target.value);
    },
    []
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              This name appears in the sidebar list.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-disabled={busy ? true : undefined}>
              <FieldLabel htmlFor="rename-chat-title">Title</FieldLabel>
              <Input
                autoComplete="off"
                disabled={busy}
                id="rename-chat-title"
                maxLength={titleLimit}
                onChange={handleTitleChange}
                value={title}
              />
            </Field>
          </FieldGroup>
          <DialogActions>
            <DialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={!canSave} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useRelativeNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, ageTickMs);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now;
}
