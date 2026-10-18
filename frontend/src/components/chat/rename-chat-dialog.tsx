import {
  type ChangeEvent,
  createContext,
  type FormEvent,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useState,
} from "react";

import type { ChatConversationMeta } from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";

const titleLimit = 60;

interface RenameChatContextValue {
  actions: { startRename: (row: ChatConversationMeta) => void };
  meta: Record<string, never>;
  state: { renaming: ChatConversationMeta | null };
}

const RenameChatContext = createContext<RenameChatContextValue | null>(null);
const emptyMeta = {};

export function useRenameChat(): RenameChatContextValue {
  const value = use(RenameChatContext);
  if (!value) {
    throw new Error("RenameChatProvider is missing.");
  }
  return value;
}

/**
 * Holds the chat being renamed and shows the dialog once, so a row, its
 * context menu, and the panel's ⋯ menu all open the same one.
 */
export function RenameChatProvider({ children }: { children: ReactNode }) {
  const [renaming, setRenaming] = useState<ChatConversationMeta | null>(null);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRenaming(null);
    }
  }, []);

  const value = useMemo<RenameChatContextValue>(
    () => ({
      actions: { startRename: setRenaming },
      meta: emptyMeta,
      state: { renaming },
    }),
    [renaming]
  );

  return (
    <RenameChatContext value={value}>
      {children}
      {renaming ? (
        <RenameConversationDialog
          key={renaming.id}
          onOpenChange={handleOpenChange}
          row={renaming}
        />
      ) : null}
    </RenameChatContext>
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
              This name appears in the chat list.
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
