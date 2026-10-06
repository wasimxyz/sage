import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  countWords,
  deleteEntry,
  generateEmbeddings,
  getEntry,
  getOllamaStatus,
  hasNativeBridge,
  type JournalEntryMeta,
  listEntries,
  listPendingEmbeddings,
  saveEntry,
  todayDate,
  waitForNativeBridge,
} from "@/bridge";
import {
  type EditorAdapter,
  type EditorSelection,
  type EntryActions,
  type EntryContextValue,
  generatingLabel,
  type JournalActions,
  type JournalContextValue,
  JournalStateProvider,
  type Section,
  type SidebarMenu,
} from "@/components/journal-context";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import type { ParsedImport } from "@/lib/parse-markdown";

const autosaveMs = 1000;
const embedDelayMs = 30_000;
const staleEmbeddingRetryMs = 15_000;
const emptyMeta = {};

function entryDeleteTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled";
}

function isDataWipePaused(ref: { current: boolean }): boolean {
  return ref.current;
}

async function saveImportedEntries(
  incoming: ParsedImport[],
  isWipePaused: () => boolean,
  loadEntries: () => Promise<void>
): Promise<number[]> {
  const ids: number[] = [];
  try {
    for (const entry of incoming) {
      if (isWipePaused()) {
        throw new Error("Import paused for data deletion.");
      }
      // biome-ignore lint/performance/noAwaitInLoops: Zig keeps one chunked save session, so imports must stay sequential
      const saved = await saveEntry({
        body: entry.body,
        date: entry.date,
        format: "markdown",
        id: null,
        title: entry.title.trim() || "Untitled",
        wordCount: entry.wordCount,
      });
      ids.push(saved.id);
    }
  } catch (error) {
    if (ids.length > 0) {
      await loadEntries();
      throw new Error(
        ids.length === 1
          ? `Imported 1 of ${incoming.length} entries.`
          : `Imported ${ids.length} of ${incoming.length} entries.`,
        { cause: error }
      );
    }
    throw error;
  }
  return ids;
}

export function JournalProvider({ children }: { children: ReactNode }) {
  const { memoryEnabled } = useMemoryFeature();
  const [section, setSection] = useState<Section>("home");
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenu>("nav");
  const [entries, setEntries] = useState<JournalEntryMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [detailOpen, setDetailOpenState] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayDate());
  const [updatedAt, setUpdatedAt] = useState("");
  const [entryLoading, setEntryLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTitle, setDeleteTitle] = useState("Untitled");
  const [saveLabel, setSaveLabel] = useState("Saved");
  const [editorReady, setEditorReady] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);

  const selectionRef = useRef(selection);
  const returnSectionRef = useRef<Exclude<Section, "settings">>("home");
  const titleRef = useRef(title);
  const dateRef = useRef(date);
  const idRef = useRef<number | null>(null);
  const pendingDeleteIdRef = useRef<number | null>(null);
  const dirtyRef = useRef<boolean>(false);
  const timerRef = useRef<number | null>(null);
  const embedTimerRef = useRef<number | null>(null);
  const pendingEmbedIdsRef = useRef(new Set<number>());
  const loadGenRef = useRef(0);
  const loadedKeyRef = useRef<string | null>(null);
  const persistChainRef = useRef(Promise.resolve());
  const embedChainRef = useRef(Promise.resolve());
  const adapterRef = useRef<EditorAdapter | null>(null);
  const persistRef = useRef<() => Promise<void>>(async () => undefined);
  const embedEntryRef = useRef<
    (id: number, showStatus: boolean) => Promise<void>
  >(async () => undefined);
  const enqueueEmbedRef = useRef<(id: number, showStatus: boolean) => void>(
    () => undefined
  );
  const scheduleEmbedRef = useRef<() => void>(() => undefined);
  const staleEmbeddingPassRef = useRef<() => Promise<boolean>>(
    async () => false
  );
  const staleEmbeddingRetryTimerRef = useRef<number | null>(null);
  const dataWipePausedRef = useRef(false);
  const activeImportsRef = useRef(0);
  const importIdleWaitersRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // Back in Settings returns to the section the owner opened it from.
  useEffect(() => {
    if (section !== "settings") {
      returnSectionRef.current = section;
    }
  }, [section]);

  useEffect(() => {
    titleRef.current = title;
    dateRef.current = date;
  }, [title, date]);

  const applySaved = useCallback((meta: JournalEntryMeta) => {
    setEntries((current) => {
      const without = current.filter((entry) => entry.id !== meta.id);
      return [meta, ...without].sort((a, b) => {
        if (a.date === b.date) {
          return b.id - a.id;
        }
        return a.date < b.date ? 1 : -1;
      });
    });
    setSelection((current) =>
      current?.kind === "id" && current.id === meta.id
        ? current
        : { id: meta.id, kind: "id" }
    );
  }, []);

  const persist = useCallback(async () => {
    const adapter = adapterRef.current;
    if (
      isDataWipePaused(dataWipePausedRef) ||
      !(adapter?.isReady() && dirtyRef.current)
    ) {
      return;
    }
    dirtyRef.current = false;
    setSaveLabel("Saving");
    const body = adapter.getBody();
    const wordCount = countWords(adapter.getText());
    const nextTitle = titleRef.current.trim() || "Untitled";
    try {
      const saved = await saveEntry({
        body,
        date: dateRef.current,
        format: "markdown",
        id: idRef.current,
        title: nextTitle,
        wordCount,
      });
      idRef.current = saved.id;
      const nextUpdatedAt =
        saved.updatedAt.length > 0 ? saved.updatedAt : new Date().toISOString();
      setUpdatedAt(nextUpdatedAt);
      applySaved({
        date: dateRef.current,
        format: "markdown",
        id: saved.id,
        title: nextTitle,
        updatedAt: nextUpdatedAt,
        wordCount,
      });
      pendingEmbedIdsRef.current.add(saved.id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: dirtyRef can be set true by scheduleSave() during the await above
      if (!dirtyRef.current) {
        setSaveLabel("Saved");
        scheduleEmbedRef.current();
      }
    } catch (error) {
      dirtyRef.current = true;
      setSaveLabel("Save failed");
      toast.error(
        error instanceof Error ? error.message : "Could not save this entry."
      );
    }
  }, [applySaved]);

  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  const clearEmbedTimer = useCallback(() => {
    if (embedTimerRef.current !== null) {
      window.clearTimeout(embedTimerRef.current);
      embedTimerRef.current = null;
    }
  }, []);

  const clearStaleEmbeddingRetry = useCallback(() => {
    if (staleEmbeddingRetryTimerRef.current !== null) {
      window.clearTimeout(staleEmbeddingRetryTimerRef.current);
      staleEmbeddingRetryTimerRef.current = null;
    }
  }, []);

  const scheduleStaleEmbeddingRetry = useCallback(() => {
    if (staleEmbeddingRetryTimerRef.current !== null) {
      return;
    }
    staleEmbeddingRetryTimerRef.current = window.setTimeout(() => {
      staleEmbeddingRetryTimerRef.current = null;
      staleEmbeddingPassRef.current().catch(() => undefined);
    }, staleEmbeddingRetryMs);
  }, []);

  useEffect(() => () => clearStaleEmbeddingRetry(), [clearStaleEmbeddingRetry]);

  const embedEntry = useCallback(
    async (id: number, showStatus: boolean) => {
      if (!pendingEmbedIdsRef.current.has(id)) {
        return;
      }
      pendingEmbedIdsRef.current.delete(id);
      let showedStatus = false;
      try {
        const status = await getOllamaStatus();
        if (!(status.running && status.modelPulled)) {
          scheduleStaleEmbeddingRetry();
          return;
        }
        if (showStatus && idRef.current === id && !dirtyRef.current) {
          setSaveLabel(generatingLabel);
          showedStatus = true;
        }
        await generateEmbeddings(id);
      } catch {
        scheduleStaleEmbeddingRetry();
      }
      if (showedStatus && idRef.current === id && !dirtyRef.current) {
        setSaveLabel((label) => (label === generatingLabel ? "Saved" : label));
      }
    },
    [scheduleStaleEmbeddingRetry]
  );

  const enqueueEmbed = useCallback((id: number, showStatus: boolean) => {
    if (!pendingEmbedIdsRef.current.has(id)) {
      return;
    }
    embedChainRef.current = embedChainRef.current
      .then(() => embedEntryRef.current(id, showStatus))
      .catch(() => undefined);
  }, []);

  const embedStaleEntries = useCallback(async (): Promise<boolean> => {
    if (!hasNativeBridge()) {
      scheduleStaleEmbeddingRetry();
      return false;
    }
    let ids: number[];
    try {
      ids = await listPendingEmbeddings();
    } catch {
      scheduleStaleEmbeddingRetry();
      return false;
    }
    if (ids.length === 0) {
      clearStaleEmbeddingRetry();
      return true;
    }
    try {
      const status = await getOllamaStatus();
      if (!(status.running && status.modelPulled)) {
        scheduleStaleEmbeddingRetry();
        return false;
      }
    } catch {
      scheduleStaleEmbeddingRetry();
      return false;
    }
    clearStaleEmbeddingRetry();
    for (const id of ids) {
      pendingEmbedIdsRef.current.add(id);
      enqueueEmbed(id, idRef.current === id);
    }
    await embedChainRef.current;
    return staleEmbeddingRetryTimerRef.current === null;
  }, [clearStaleEmbeddingRetry, enqueueEmbed, scheduleStaleEmbeddingRetry]);

  const scheduleEmbed = useCallback(() => {
    clearEmbedTimer();
    embedTimerRef.current = window.setTimeout(() => {
      embedTimerRef.current = null;
      const id = idRef.current;
      if (id !== null) {
        enqueueEmbed(id, true);
      }
    }, embedDelayMs);
  }, [clearEmbedTimer, enqueueEmbed]);

  useEffect(() => {
    embedEntryRef.current = embedEntry;
  }, [embedEntry]);

  useEffect(() => {
    enqueueEmbedRef.current = enqueueEmbed;
  }, [enqueueEmbed]);

  useEffect(() => {
    scheduleEmbedRef.current = scheduleEmbed;
  }, [scheduleEmbed]);

  useEffect(() => {
    staleEmbeddingPassRef.current = embedStaleEntries;
  }, [embedStaleEntries]);

  const scheduleSave = useCallback(() => {
    if (isDataWipePaused(dataWipePausedRef)) {
      return;
    }
    dirtyRef.current = true;
    setSaveLabel("Unsaved");
    clearEmbedTimer();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      persistChainRef.current = persistChainRef.current.then(() =>
        persistRef.current()
      );
    }, autosaveMs);
  }, [clearEmbedTimer]);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearEmbedTimer();
    persistChainRef.current = persistChainRef.current.then(() =>
      persistRef.current()
    );
    await persistChainRef.current;
    clearEmbedTimer();
    const id = idRef.current;
    if (id !== null) {
      enqueueEmbed(id, false);
    }
  }, [clearEmbedTimer, enqueueEmbed]);

  const registerEditor = useCallback((adapter: EditorAdapter | null) => {
    adapterRef.current = adapter;
    if (adapter === null) {
      loadedKeyRef.current = null;
      setEditorReady(false);
      return;
    }
    loadedKeyRef.current = null;
    setEditorReady(true);
    setEditorGeneration((current) => current + 1);
  }, []);

  const changeTitle = useCallback(
    (nextTitle: string) => {
      setTitle(nextTitle);
      scheduleSave();
    },
    [scheduleSave]
  );

  const openDelete = useCallback(() => {
    pendingDeleteIdRef.current = idRef.current;
    setDeleteTitle(entryDeleteTitle(titleRef.current));
    setDeleteOpen(true);
  }, []);

  const openDeleteEntry = useCallback(
    (id: number) => {
      pendingDeleteIdRef.current = id;
      const entry = entries.find((item) => item.id === id);
      setDeleteTitle(entryDeleteTitle(entry?.title ?? ""));
      setDeleteOpen(true);
    },
    [entries]
  );

  const confirmDelete = useCallback(async () => {
    const id = pendingDeleteIdRef.current;
    if (id === null) {
      dirtyRef.current = false;
      setDeleteOpen(false);
      setSelection(null);
      setExpanded(false);
      return;
    }
    try {
      await deleteEntry(id);
      const selected = selectionRef.current;
      const isCurrent =
        idRef.current === id || (selected?.kind === "id" && selected.id === id);
      if (isCurrent) {
        dirtyRef.current = false;
        clearEmbedTimer();
        setSelection(null);
        setExpanded(false);
      }
      pendingEmbedIdsRef.current.delete(id);
      setDeleteOpen(false);
      toast("Entry deleted.");
      setEntries((current) => current.filter((entry) => entry.id !== id));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete this entry."
      );
    }
  }, [clearEmbedTimer]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!(selection && editorReady && adapter?.isReady())) {
      return;
    }

    const key =
      selection.kind === "id"
        ? `${editorGeneration}:${selection.id}`
        : `${editorGeneration}:draft`;
    if (loadedKeyRef.current === key) {
      return;
    }
    loadedKeyRef.current = key;

    dirtyRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (selection.kind === "draft") {
      idRef.current = null;
      setTitle("");
      setDate(todayDate());
      setUpdatedAt("");
      setEntryLoading(false);
      setSaveLabel("Unsaved");
      adapter.resetDraft();
      return;
    }

    loadGenRef.current += 1;
    const gen = loadGenRef.current;
    setEntryLoading(true);
    idRef.current = selection.id;
    const { id } = selection;
    getEntry(id)
      .then((entry) => {
        if (gen !== loadGenRef.current) {
          return;
        }
        const { current } = adapterRef;
        if (!current?.isReady()) {
          return;
        }
        idRef.current = entry.id;
        setTitle(entry.title);
        setDate(entry.date);
        setUpdatedAt(entry.updatedAt);
        current.loadDoc(entry);
        setSaveLabel("Saved");
        setEntryLoading(false);
      })
      .catch((error: unknown) => {
        if (gen !== loadGenRef.current) {
          return;
        }
        setEntryLoading(false);
        toast.error(
          error instanceof Error ? error.message : "Could not open this entry."
        );
      });
  }, [editorGeneration, editorReady, selection]);

  useEffect(() => {
    const flushNow = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (embedTimerRef.current !== null) {
        window.clearTimeout(embedTimerRef.current);
        embedTimerRef.current = null;
      }
      persistChainRef.current = persistChainRef.current
        .then(() => persistRef.current())
        .then(() => {
          if (embedTimerRef.current !== null) {
            window.clearTimeout(embedTimerRef.current);
            embedTimerRef.current = null;
          }
          const id = idRef.current;
          if (id !== null) {
            enqueueEmbedRef.current(id, false);
          }
        });
    };
    const onPageHide = () => {
      flushNow();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushNow();
    };
  }, []);

  const loadEntries = useCallback(async () => {
    const ready = (await waitForNativeBridge()) && hasNativeBridge();
    if (!ready) {
      setLoadingList(false);
      toast.error("Sage needs the desktop app to read your journal.");
      return;
    }
    setLoadingList(true);
    try {
      const next = await listEntries();
      setEntries(next);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load journal entries."
      );
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadEntries()
      .then(() => embedStaleEntries())
      .catch(() => {
        // loadEntries already toasts its own errors.
      });
  }, [embedStaleEntries, loadEntries]);

  const beginDataWipe = useCallback(async () => {
    dataWipePausedRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await persistChainRef.current.catch(() => undefined);
    if (activeImportsRef.current > 0) {
      await new Promise<void>((resolve) => {
        importIdleWaitersRef.current.push(resolve);
      });
    }
  }, []);

  const endDataWipe = useCallback(() => {
    dataWipePausedRef.current = false;
  }, []);

  const refreshAfterDataWipe = useCallback(async () => {
    await loadEntries();
    if (selectionRef.current?.kind !== "id") {
      return;
    }
    loadGenRef.current += 1;
    dirtyRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearEmbedTimer();
    pendingEmbedIdsRef.current.clear();
    idRef.current = null;
    adapterRef.current?.resetDraft();
    setSelection(null);
    setDetailOpenState(false);
    setExpanded(false);
    setEntryLoading(false);
    setDeleteOpen(false);
    setTitle("");
    setDate(todayDate());
    setUpdatedAt("");
    setSaveLabel("Saved");
  }, [clearEmbedTimer, loadEntries]);

  const showHome = useCallback(async () => {
    await flush();
    setSection("home");
    setSidebarMenu("nav");
    setExpanded(false);
  }, [flush]);

  const showChat = useCallback(async () => {
    await flush();
    setSection("chat");
    setSidebarMenu("conversations");
    setExpanded(false);
  }, [flush]);

  const showJournal = useCallback(async () => {
    setSection("journal");
    setSidebarMenu("nav");
    if (entries.length === 0 && !loadingList) {
      await loadEntries();
    }
  }, [entries.length, loadEntries, loadingList]);

  const showMemories = useCallback(async () => {
    if (!memoryEnabled) {
      return;
    }
    await flush();
    setSection("memories");
    setSidebarMenu("nav");
    setExpanded(false);
  }, [flush, memoryEnabled]);

  const showSettings = useCallback(async () => {
    await flush();
    setSection("settings");
    setSidebarMenu("settings");
    setExpanded(false);
  }, [flush]);

  const closeSettings = useCallback(async () => {
    const target = returnSectionRef.current;
    if (target === "home") {
      await showHome();
    } else if (target === "chat") {
      await showChat();
    } else if (target === "memories") {
      await showMemories();
    } else {
      await showJournal();
    }
  }, [showChat, showHome, showJournal, showMemories]);

  const showNavMenu = useCallback(() => {
    setSidebarMenu("nav");
  }, []);

  const select = useCallback(
    async (id: number) => {
      const { current } = selectionRef;
      if (current?.kind === "id" && current.id === id) {
        setSection("journal");
        setSidebarMenu("nav");
        setDetailOpenState(true);
        return;
      }
      await flush();
      setSection("journal");
      setSidebarMenu("nav");
      setSelection({ id, kind: "id" });
      setDetailOpenState(true);
      setEntryLoading(true);
    },
    [flush]
  );

  const startDraft = useCallback(async () => {
    await flush();
    setSection("journal");
    setSidebarMenu("nav");
    setSelection({ kind: "draft" });
    setDetailOpenState(true);
    setEntryLoading(false);
  }, [flush]);

  const embedImportedEntries = useCallback(
    async (
      ids: number[],
      onEmbedProgress?: (done: number, total: number) => void
    ) => {
      try {
        const status = await getOllamaStatus();
        if (!(status.running && status.modelPulled)) {
          return;
        }
      } catch {
        return;
      }
      onEmbedProgress?.(0, ids.length);
      for (const [index, id] of ids.entries()) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: embeddings must finish one entry before the next so the dialog can show progress
          await generateEmbeddings(id);
        } catch {
          // Keep going so a single failure does not stop the rest.
        }
        onEmbedProgress?.(index + 1, ids.length);
      }
    },
    []
  );

  const importEntries = useCallback(
    async (
      incoming: ParsedImport[],
      onEmbedProgress?: (done: number, total: number) => void
    ) => {
      if (isDataWipePaused(dataWipePausedRef)) {
        throw new Error("Sage is deleting data. Try the import again.");
      }
      activeImportsRef.current += 1;
      try {
        await flush();
        const ids = await saveImportedEntries(
          incoming,
          () => dataWipePausedRef.current,
          loadEntries
        );
        if (ids.length > 0) {
          await loadEntries();
          await embedImportedEntries(ids, onEmbedProgress);
        }
        return ids.length;
      } finally {
        activeImportsRef.current -= 1;
        if (activeImportsRef.current === 0) {
          for (const resolve of importIdleWaitersRef.current.splice(0)) {
            resolve();
          }
        }
      }
    },
    [embedImportedEntries, flush, loadEntries]
  );

  const setDetailOpen = useCallback((open: boolean) => {
    setDetailOpenState(open);
    if (!open) {
      setExpanded(false);
    }
  }, []);

  const journalActions = useMemo<JournalActions>(
    () => ({
      beginDataWipe,
      closeSettings,
      endDataWipe,
      importEntries,
      refreshAfterDataWipe,
      runStaleEmbeddingPass: embedStaleEntries,
      select,
      setDetailOpen,
      setExpanded,
      showChat,
      showHome,
      showJournal,
      showMemories,
      showNavMenu,
      showSettings,
      startDraft,
    }),
    [
      beginDataWipe,
      closeSettings,
      embedStaleEntries,
      endDataWipe,
      importEntries,
      refreshAfterDataWipe,
      select,
      setDetailOpen,
      showChat,
      showHome,
      showJournal,
      showMemories,
      showNavMenu,
      showSettings,
      startDraft,
    ]
  );

  const entryActions = useMemo<EntryActions>(
    () => ({
      changeTitle,
      confirmDelete,
      flush,
      openDelete,
      openDeleteEntry,
      registerEditor,
      scheduleSave,
      setDeleteOpen,
    }),
    [
      changeTitle,
      confirmDelete,
      flush,
      openDelete,
      openDeleteEntry,
      registerEditor,
      scheduleSave,
    ]
  );

  const journalValue = useMemo<JournalContextValue>(
    () => ({
      actions: journalActions,
      meta: emptyMeta,
      state: {
        detailOpen,
        entries,
        expanded,
        loadingList,
        section,
        selectedId: selection?.kind === "id" ? selection.id : null,
        selection,
        sidebarMenu,
      },
    }),
    [
      detailOpen,
      entries,
      expanded,
      journalActions,
      loadingList,
      section,
      selection,
      sidebarMenu,
    ]
  );

  const entryValue = useMemo<EntryContextValue>(
    () => ({
      actions: entryActions,
      meta: emptyMeta,
      state: {
        date,
        deleteOpen,
        deleteTitle,
        loading: entryLoading,
        saveLabel,
        title,
        updatedAt,
      },
    }),
    [
      date,
      deleteOpen,
      deleteTitle,
      entryActions,
      entryLoading,
      saveLabel,
      title,
      updatedAt,
    ]
  );

  return (
    <JournalStateProvider entry={entryValue} journal={journalValue}>
      {children}
    </JournalStateProvider>
  );
}
