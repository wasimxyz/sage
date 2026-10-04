import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import {
  type DataCounts,
  deleteAllData,
  deleteConversations,
  deleteEmbeddings,
  deleteJournalEntries,
  deleteMemories,
  getDataCounts,
} from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { useJournal } from "@/components/journal-context";
import { useMemories } from "@/components/memories-provider";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { SettingsRow } from "@/components/settings-row";
import { SettingsSection } from "@/components/settings-section";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { exportDataWithToast } from "@/lib/export-data";

const sectionHeadingClassName =
  "mt-6 font-medium text-muted-foreground text-sm";

interface DeleteConfirmation {
  confirmLabel: string;
  description: string;
  onConfirm: () => Promise<void>;
  title: string;
}

export function DataSettings() {
  const { memoryEnabled } = useMemoryFeature();
  const {
    actions: {
      beginDataWipe,
      endDataWipe,
      refreshAfterDataWipe,
      runStaleEmbeddingPass,
    },
  } = useJournal();
  const {
    actions: { newChat, refreshList },
  } = useChat();
  const {
    actions: { refresh: refreshMemories },
  } = useMemories();
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [counts, setCounts] = useState<DataCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(
    null
  );
  const [typedConfirmation, setTypedConfirmation] = useState("");

  const refreshCounts = useCallback(async () => {
    setCounts(null);
    setCountsLoading(true);
    try {
      setCounts(await getDataCounts());
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not load data counts."
      );
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCounts().catch(() => undefined);
  }, [refreshCounts]);

  const handleExport = useCallback(() => {
    if (exportBusy) {
      return;
    }
    setExportBusy(true);
    exportDataWithToast().finally(() => setExportBusy(false));
  }, [exportBusy]);

  const showConfirmation = useCallback((next: DeleteConfirmation) => {
    setTypedConfirmation("");
    setConfirmation(next);
  }, []);

  const deleteEntries = useCallback(async () => {
    await beginDataWipe();
    try {
      await deleteJournalEntries();
      await refreshAfterDataWipe();
      await refreshMemories();
      await refreshCounts();
    } finally {
      endDataWipe();
    }
  }, [
    beginDataWipe,
    endDataWipe,
    refreshAfterDataWipe,
    refreshCounts,
    refreshMemories,
  ]);

  const deleteChats = useCallback(async () => {
    flushSync(() => newChat());
    await deleteConversations();
    await Promise.all([refreshList(), refreshMemories(), refreshCounts()]);
  }, [newChat, refreshCounts, refreshList, refreshMemories]);

  const deleteIndexes = useCallback(async () => {
    await deleteEmbeddings();
    const rebuilt = await runStaleEmbeddingPass();
    if (!rebuilt) {
      toast.info("Entries will be re-embedded when Ollama is available.");
    }
    await refreshCounts();
  }, [refreshCounts, runStaleEmbeddingPass]);

  const deleteMemoryRows = useCallback(async () => {
    await deleteMemories();
    await refreshMemories();
    await refreshCounts();
  }, [refreshCounts, refreshMemories]);

  const deleteEverything = useCallback(async () => {
    flushSync(() => newChat());
    await beginDataWipe();
    try {
      await deleteAllData();
      clearWebViewStore();
      window.location.reload();
    } finally {
      endDataWipe();
    }
  }, [beginDataWipe, endDataWipe, newChat]);

  const handleConfirm = useCallback(async () => {
    if (!confirmation || busy || typedConfirmation !== "delete") {
      return;
    }
    setBusy(true);
    try {
      await confirmation.onConfirm();
      setConfirmation(null);
      setTypedConfirmation("");
    } catch (error) {
      toast.error(deleteWipeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [busy, confirmation, typedConfirmation]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (busy && !nextOpen) {
        return;
      }
      if (!nextOpen) {
        setConfirmation(null);
        setTypedConfirmation("");
      }
    },
    [busy]
  );

  const entriesConfirmation = useCallback(() => {
    showConfirmation({
      confirmLabel: "Delete entries",
      description:
        "This permanently deletes every journal entry and every memory Dream wrote from those entries. Memories you added stay. This cannot be undone.",
      onConfirm: deleteEntries,
      title: "Delete journal entries?",
    });
  }, [deleteEntries, showConfirmation]);

  const conversationsConfirmation = useCallback(() => {
    showConfirmation({
      confirmLabel: "Delete conversations",
      description:
        "This permanently deletes every conversation and every memory Dream wrote from those conversations. Memories you added stay. This cannot be undone.",
      onConfirm: deleteChats,
      title: "Delete conversations?",
    });
  }, [deleteChats, showConfirmation]);

  const embeddingsConfirmation = useCallback(() => {
    const rebuildDescription = memoryEnabled
      ? "Sage re-embeds entries when Ollama is available. The next Dream rebuilds summaries and Chat indexes."
      : "Sage re-embeds entries when Ollama is available. The next Dream rebuilds summaries.";
    showConfirmation({
      confirmLabel: "Delete embeddings",
      description: `This permanently deletes the journal and Chat index embeddings. Journal entries, conversations, and memories stay. ${rebuildDescription} This cannot be undone.`,
      onConfirm: deleteIndexes,
      title: "Delete embeddings?",
    });
  }, [deleteIndexes, memoryEnabled, showConfirmation]);

  const memoriesConfirmation = useCallback(() => {
    showConfirmation({
      confirmLabel: "Delete memories",
      description:
        "This permanently deletes every memory, including ones you added. Your journal and conversations stay. The next Dream can learn these again from them. This cannot be undone.",
      onConfirm: deleteMemoryRows,
      title: "Delete memories?",
    });
  }, [deleteMemoryRows, showConfirmation]);

  const allDataConfirmation = useCallback(() => {
    showConfirmation({
      confirmLabel: "Delete all data",
      description:
        "This permanently deletes every journal entry, conversation, embedding, summary, and memory. Your lock password, Touch ID, encryption settings, and Chat instructions stay. The last Chat model, Thinking setting, and context length this window stored are cleared too. This cannot be undone.",
      onConfirm: deleteEverything,
      title: "Delete all data?",
    });
  }, [deleteEverything, showConfirmation]);

  return (
    <SettingsSection description="Manage your data and storage." title="Data">
      <h3 className={sectionHeadingClassName}>Export</h3>
      <div className="flex flex-col divide-y">
        <SettingsRow
          description="Export journal entries and conversations as Markdown and JSON files."
          title="Export data"
        >
          <Button
            disabled={exportBusy}
            onClick={handleExport}
            size="sm"
            variant="outline"
          >
            {exportBusy ? <Spinner data-icon="inline-start" /> : null}
            Export
          </Button>
        </SettingsRow>
      </div>
      <h3 className={sectionHeadingClassName}>Danger Zone</h3>
      <div className="flex flex-col divide-y">
        <JournalEntriesRow
          count={counts?.entries ?? null}
          loading={countsLoading}
          onDelete={entriesConfirmation}
        />
        <ConversationsRow
          count={counts?.conversations ?? null}
          loading={countsLoading}
          onDelete={conversationsConfirmation}
        />
        <EmbeddingsRow
          count={counts?.embeddings ?? null}
          loading={countsLoading}
          onDelete={embeddingsConfirmation}
        />
        {memoryEnabled ? (
          <MemoriesRow
            count={counts?.memories ?? null}
            loading={countsLoading}
            onDelete={memoriesConfirmation}
          />
        ) : null}
        <DeleteAllDataRow onDelete={allDataConfirmation} />
      </div>
      <TypedConfirmDialog
        busy={busy}
        confirmation={confirmation}
        onConfirm={handleConfirm}
        onOpenChange={handleDialogOpenChange}
        onTypedConfirmationChange={setTypedConfirmation}
        open={confirmation !== null}
        typedConfirmation={typedConfirmation}
      />
    </SettingsSection>
  );
}

function JournalEntriesRow({ count, loading, onDelete }: CountedRowProps) {
  return (
    <CountedWipeRow
      count={count}
      description="Delete every journal entry and memories Dream wrote from entries. Memories you added stay."
      loading={loading}
      onDelete={onDelete}
      title="Journal entries"
    />
  );
}

function ConversationsRow({ count, loading, onDelete }: CountedRowProps) {
  return (
    <CountedWipeRow
      count={count}
      description="Delete every conversation and memories Dream wrote from conversations. Memories you added stay."
      loading={loading}
      onDelete={onDelete}
      title="Conversations"
    />
  );
}

function EmbeddingsRow({ count, loading, onDelete }: CountedRowProps) {
  return (
    <CountedWipeRow
      count={count}
      description="Delete journal and Chat indexes. Entries, conversations, and memories stay."
      loading={loading}
      onDelete={onDelete}
      title="Embeddings"
    />
  );
}

function MemoriesRow({ count, loading, onDelete }: CountedRowProps) {
  return (
    <CountedWipeRow
      count={count}
      description="Delete every memory, including ones you added. Journal and conversations stay."
      loading={loading}
      onDelete={onDelete}
      title="Memories"
    />
  );
}

interface CountedRowProps {
  count: number | null;
  loading: boolean;
  onDelete: () => void;
}

function CountedWipeRow({
  count,
  description,
  loading,
  onDelete,
  title,
}: CountedRowProps & { description: string; title: string }) {
  return (
    <SettingsRow description={description} title={title}>
      <div className="flex items-center gap-3">
        <span
          aria-live="polite"
          className="min-w-5 text-right text-muted-foreground text-sm tabular-nums"
        >
          {count === null ? "…" : count.toLocaleString()}
        </span>
        <Button
          disabled={loading || count === null || count === 0}
          onClick={onDelete}
          size="sm"
          variant="destructive"
        >
          Delete
        </Button>
      </div>
    </SettingsRow>
  );
}

function DeleteAllDataRow({ onDelete }: { onDelete: () => void }) {
  return (
    <SettingsRow
      description="Permanently delete your journal, conversations, and memories. This cannot be undone."
      title="Delete all data"
    >
      <Button onClick={onDelete} size="sm" variant="destructive">
        Delete
      </Button>
    </SettingsRow>
  );
}

function TypedConfirmDialog({
  busy,
  confirmation,
  onConfirm,
  onOpenChange,
  onTypedConfirmationChange,
  open,
  typedConfirmation,
}: {
  busy: boolean;
  confirmation: DeleteConfirmation | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onTypedConfirmationChange: (value: string) => void;
  open: boolean;
  typedConfirmation: string;
}) {
  const handleTypedConfirmationChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onTypedConfirmationChange(event.target.value);
    },
    [onTypedConfirmationChange]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirmation?.title}</DialogTitle>
          <DialogDescription>{confirmation?.description}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="data-wipe-confirmation">
            Type delete to confirm
          </FieldLabel>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy}
            id="data-wipe-confirmation"
            onChange={handleTypedConfirmationChange}
            spellCheck={false}
            value={typedConfirmation}
          />
        </Field>
        <DialogActions>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={busy || typedConfirmation !== "delete"}
            onClick={onConfirm}
            variant="destructive"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {confirmation?.confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function deleteWipeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Locked")) {
    return "Unlock the app first.";
  }
  if (message.includes("Securing")) {
    return "Wait until Sage finishes securing your journal.";
  }
  return message.length > 0 ? message : "Could not delete this data.";
}

function clearWebViewStore(): void {
  try {
    localStorage.clear();
  } catch {
    // Private mode or a disabled store has nothing to clear.
  }
}
