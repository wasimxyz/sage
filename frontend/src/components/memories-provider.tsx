import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import {
  deleteMemory,
  type EventMemory,
  type FactMemory,
  hasNativeBridge,
  listMemories,
  type MemoryKind,
  type MemorySearchHit,
  onDreamFinished,
  type ProfileMemory,
  type SaveMemoryInput,
  saveMemory,
  waitForNativeBridge,
} from "@/bridge";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import {
  groupForSubjectKey,
  factSubjectKey as subjectKeyFromLabel,
} from "@/lib/group-facts";
import type { MemoriesTab } from "@/lib/route";

const emptyMeta = {};
const emptyEvents: EventMemory[] = [];
const emptyFacts: FactMemory[] = [];
const emptyProfile: ProfileMemory[] = [];

export type MemoryEditor =
  | { fact: string; id?: number; kind: "profile" }
  | { fact: string; id?: number; kind: "fact"; subject: string }
  | { event: string; id?: number; kind: "event"; occurredAt: string }
  | { kind: "profile-group" }
  | { kind: "fact-group"; key: string };

export type MemoryDeleteTarget =
  | { id: number; kind: MemoryKind; title: string }
  | { ids: number[]; kind: "fact-group"; title: string }
  | { ids: number[]; kind: "profile-group"; title: string };

export type MemorySubjectView =
  | { kind: "profile" }
  | { kind: "topic"; key: string };

interface MemoriesState {
  deleteTarget: MemoryDeleteTarget | null;
  editor: MemoryEditor | null;
  events: EventMemory[];
  facts: FactMemory[];
  loading: boolean;
  profile: ProfileMemory[];
  subjectView: MemorySubjectView | null;
  tab: MemoriesTab;
}

interface MemoriesActions {
  closeDelete: () => void;
  closeEditor: () => void;
  closeSubject: () => void;
  openCreate: (kind: MemoryKind, draft?: { subject: string }) => void;
  openDelete: (target: MemoryDeleteTarget) => void;
  openEdit: (editor: MemoryEditor) => void;
  openFactSubject: (key: string) => void;
  openProfileSubject: () => void;
  openSearchHit: (hit: MemorySearchHit) => void;
  refresh: () => Promise<void>;
  remove: (kind: MemoryKind, id: number) => Promise<void>;
  removeMany: (kind: "fact" | "profile", ids: number[]) => Promise<void>;
  save: (input: SaveMemoryInput) => Promise<void>;
  saveAll: (
    inputs: SaveMemoryInput[],
    deletes: { ids: number[]; kind: "fact" | "profile" }
  ) => Promise<void>;
  setTab: (tab: MemoriesTab) => void;
}

interface MemoriesContextValue {
  actions: MemoriesActions;
  meta: Record<string, never>;
  state: MemoriesState;
}

const MemoriesContext = createContext<MemoriesContextValue | null>(null);

export function useMemories(): MemoriesContextValue {
  const value = use(MemoriesContext);
  if (!value) {
    throw new Error("MemoriesProvider is missing.");
  }
  return value;
}

export function MemoriesProvider({ children }: { children: ReactNode }) {
  const { memoryEnabled, ready: featureReady } = useMemoryFeature();
  const [tab, setTab] = useState<MemoriesTab>("facts");
  const [profile, setProfile] = useState<ProfileMemory[]>(emptyProfile);
  const [facts, setFacts] = useState<FactMemory[]>(emptyFacts);
  const [events, setEvents] = useState<EventMemory[]>(emptyEvents);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<MemoryEditor | null>(null);
  const [subjectView, setSubjectView] = useState<MemorySubjectView | null>(
    null
  );
  const [deleteTarget, setDeleteTarget] = useState<MemoryDeleteTarget | null>(
    null
  );

  const refresh = useCallback(async () => {
    if (!featureReady) {
      return;
    }
    if (!memoryEnabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const ready = (await waitForNativeBridge()) && hasNativeBridge();
    if (!ready) {
      setLoading(false);
      toast.error("Sage needs the desktop app to read Memories.");
      return;
    }
    try {
      const next = await listMemories();
      setProfile(next.profile);
      setFacts(next.facts);
      setEvents(next.events);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Could not load Memories."
      );
    } finally {
      setLoading(false);
    }
  }, [featureReady, memoryEnabled]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!(featureReady && memoryEnabled)) {
      return;
    }
    return onDreamFinished(() => {
      refresh().catch(() => undefined);
    });
  }, [featureReady, memoryEnabled, refresh]);

  const closeEditor = useCallback(() => {
    setEditor(null);
  }, []);

  const closeDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const closeSubject = useCallback(() => {
    setSubjectView(null);
    setEditor(closeGroupEditor);
  }, []);

  const openFactSubject = useCallback((key: string) => {
    setEditor((current) => keepEditorForTopic(current, key));
    setSubjectView({ key, kind: "topic" });
  }, []);

  const openProfileSubject = useCallback(() => {
    setEditor((current) => keepEditorForProfile(current));
    setSubjectView({ kind: "profile" });
  }, []);

  const openSearchHit = useCallback((hit: MemorySearchHit) => {
    if (hit.kind === "event") {
      setTab("events");
      setSubjectView(null);
      setEditor({
        event: hit.event,
        id: hit.id,
        kind: "event",
        occurredAt: hit.occurredAt,
      });
      return;
    }
    setTab("facts");
    setEditor(null);
    if (hit.kind === "profile") {
      setSubjectView({ kind: "profile" });
      return;
    }
    setSubjectView({
      key: subjectKeyFromLabel(hit.subject),
      kind: "topic",
    });
  }, []);

  const selectTab = useCallback((next: MemoriesTab) => {
    setSubjectView(null);
    setEditor(closeGroupEditor);
    setTab(next);
  }, []);

  const openCreate = useCallback(
    (kind: MemoryKind, draft?: { subject: string }) => {
      if (kind === "fact") {
        setEditor({ fact: "", kind: "fact", subject: draft?.subject ?? "" });
        return;
      }
      if (kind === "event") {
        setEditor({ event: "", kind: "event", occurredAt: "" });
        return;
      }
      setEditor({ fact: "", kind: "profile" });
    },
    []
  );

  const openEdit = useCallback((next: MemoryEditor) => {
    setEditor(next);
  }, []);

  const openDelete = useCallback((target: MemoryDeleteTarget) => {
    setDeleteTarget(target);
  }, []);

  const save = useCallback(
    async (input: SaveMemoryInput) => {
      await saveMemory(input);
      setEditor(null);
      if (input.kind === "fact") {
        setSubjectView((current) =>
          current?.kind === "topic"
            ? { key: subjectKeyFromLabel(input.subject), kind: "topic" }
            : current
        );
      }
      await refresh();
    },
    [refresh]
  );

  const saveAll = useCallback(
    async (
      inputs: SaveMemoryInput[],
      deletes: { ids: number[]; kind: "fact" | "profile" }
    ) => {
      await Promise.all(inputs.map((input) => saveMemory(input)));
      await Promise.all(
        deletes.ids.map((id) => deleteMemory(deletes.kind, id))
      );
      setEditor(null);
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    async (kind: MemoryKind, id: number) => {
      try {
        await deleteMemory(kind, id);
        setDeleteTarget(null);
        await refresh();
        toast("Memory deleted.");
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not delete this memory."
        );
        throw caught;
      }
    },
    [refresh]
  );

  const removeMany = useCallback(
    async (kind: "fact" | "profile", ids: number[]) => {
      try {
        await Promise.all(ids.map((id) => deleteMemory(kind, id)));
        setDeleteTarget(null);
        await refresh();
        toast("Memory deleted.");
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not delete this memory."
        );
        throw caught;
      }
    },
    [refresh]
  );

  useEffect(() => {
    if (subjectView === null || loading) {
      return;
    }
    if (subjectView.kind === "topic") {
      if (groupForSubjectKey(facts, subjectView.key) === null) {
        setSubjectView(null);
        setEditor(closeGroupEditor);
      }
      return;
    }
    if (profile.length === 0) {
      setSubjectView(null);
      setEditor(closeGroupEditor);
    }
  }, [facts, loading, profile.length, subjectView]);

  const state = useMemo<MemoriesState>(
    () => ({
      deleteTarget,
      editor,
      events,
      facts,
      loading,
      profile,
      subjectView,
      tab,
    }),
    [deleteTarget, editor, events, facts, loading, profile, subjectView, tab]
  );

  const actions = useMemo<MemoriesActions>(
    () => ({
      closeDelete,
      closeEditor,
      closeSubject,
      openCreate,
      openDelete,
      openEdit,
      openFactSubject,
      openProfileSubject,
      openSearchHit,
      refresh,
      remove,
      removeMany,
      save,
      saveAll,
      setTab: selectTab,
    }),
    [
      closeDelete,
      closeEditor,
      closeSubject,
      openCreate,
      openDelete,
      openEdit,
      openFactSubject,
      openProfileSubject,
      openSearchHit,
      refresh,
      remove,
      removeMany,
      save,
      saveAll,
      selectTab,
    ]
  );

  const value = useMemo<MemoriesContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return <MemoriesContext value={value}>{children}</MemoriesContext>;
}

function isGroupEditor(editor: MemoryEditor | null): boolean {
  return editor?.kind === "fact-group" || editor?.kind === "profile-group";
}

function closeGroupEditor(editor: MemoryEditor | null): MemoryEditor | null {
  return isGroupEditor(editor) ? null : editor;
}

function keepEditorForTopic(
  editor: MemoryEditor | null,
  key: string
): MemoryEditor | null {
  if (editor?.kind === "fact-group" && editor.key === key) {
    return editor;
  }
  return closeGroupEditor(editor);
}

function keepEditorForProfile(
  editor: MemoryEditor | null
): MemoryEditor | null {
  if (editor?.kind === "profile-group") {
    return editor;
  }
  return closeGroupEditor(editor);
}
