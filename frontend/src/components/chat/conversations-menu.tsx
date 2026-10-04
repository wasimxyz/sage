import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

import type { ChatConversationMeta } from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { useJournal } from "@/components/journal-context";
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
import { formatRelativeAge } from "@/lib/format-relative-age";

const ageTickMs = 60_000;
const titleLimit = 60;
const conversationItemClass =
  "justify-between [&>span:last-child]:overflow-visible [content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]";

type ConversationDialog =
  | { kind: "delete"; row: ChatConversationMeta }
  | { kind: "rename"; row: ChatConversationMeta }
  | null;

export function ConversationsMenu() {
  const {
    actions: { refreshList },
    state: { conversations, selection },
  } = useChat();
  const now = useRelativeNow();
  const activeId = selection.kind === "saved" ? selection.id : null;
  const [dialog, setDialog] = useState<ConversationDialog>(null);

  useEffect(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDialog(null);
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
          <SidebarMenu>
            {conversations.length === 0 ? (
              <SidebarMenuItem>
                <span className="px-2 py-1.5 text-muted-foreground text-sm">
                  No saved chats
                </span>
              </SidebarMenuItem>
            ) : (
              conversations.map((row) => (
                <ConversationItem
                  active={row.id === activeId}
                  key={row.id}
                  now={now}
                  row={row}
                  setDialog={setDialog}
                />
              ))
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {dialog?.kind === "rename" ? (
        <RenameConversationDialog
          key={dialog.row.id}
          onOpenChange={handleDialogOpenChange}
          row={dialog.row}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteConversationDialog
          key={dialog.row.id}
          onOpenChange={handleDialogOpenChange}
          row={dialog.row}
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
        isActive={selection.kind === "new"}
        onClick={newChat}
        tooltip="New chat"
      >
        <PlusIcon />
        <span>New chat</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ConversationsBackButton() {
  const {
    actions: { showJournal },
  } = useJournal();
  return <SidebarBackButton onClick={showJournal} />;
}

function ConversationItem({
  active,
  now,
  row,
  setDialog,
}: {
  active: boolean;
  now: number;
  row: ChatConversationMeta;
  setDialog: (dialog: ConversationDialog) => void;
}) {
  const {
    actions: { openConversation },
  } = useChat();
  const onClick = useCallback(() => {
    openConversation(row.id);
  }, [openConversation, row.id]);
  const onRename = useCallback(() => {
    setDialog({ kind: "rename", row });
  }, [row, setDialog]);
  const onDelete = useCallback(() => {
    setDialog({ kind: "delete", row });
  }, [row, setDialog]);
  return (
    <SidebarMenuItem>
      <Tooltip>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <TooltipTrigger
                render={
                  <SidebarMenuButton
                    className={conversationItemClass}
                    isActive={active}
                    onClick={onClick}
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
    </SidebarMenuItem>
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

function DeleteConversationDialog({
  onOpenChange,
  row,
}: {
  onOpenChange: (open: boolean) => void;
  row: ChatConversationMeta;
}) {
  const {
    actions: { deleteConversation },
  } = useChat();
  const [busy, setBusy] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (busy && !open) {
        return;
      }
      onOpenChange(open);
    },
    [busy, onOpenChange]
  );

  const handleConfirmClick = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    deleteConversation(row.id)
      .then(() => {
        setBusy(false);
        onOpenChange(false);
      })
      .catch(() => {
        setBusy(false);
      });
  }, [busy, deleteConversation, onOpenChange, row.id]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            This removes "{row.title}" from Sage on this machine. Memories Dream
            took from this chat go too. You cannot undo it.
          </DialogDescription>
        </DialogHeader>
        <DialogActions>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={busy}
            onClick={handleConfirmClick}
            variant="destructive"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Delete
          </Button>
        </DialogActions>
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
