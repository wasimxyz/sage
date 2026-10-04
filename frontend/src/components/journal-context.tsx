import { createContext, type ReactNode, use } from "react";

import type { JournalEntry, JournalEntryMeta } from "@/bridge";
import type { ParsedImport } from "@/lib/parse-markdown";

export const generatingLabel = "Generating embedding...";

export type Section = "chat" | "home" | "journal" | "memories" | "settings";

export type SidebarMenu = "conversations" | "nav" | "settings";

export type EditorSelection = { kind: "id"; id: number } | { kind: "draft" };

export interface EditorAdapter {
  getBody: () => string;
  getText: () => string;
  isReady: () => boolean;
  loadDoc: (entry: JournalEntry) => void;
  resetDraft: () => void;
}

export interface JournalState {
  detailOpen: boolean;
  entries: JournalEntryMeta[];
  expanded: boolean;
  loadingList: boolean;
  section: Section;
  selectedId: number | null;
  selection: EditorSelection | null;
  sidebarMenu: SidebarMenu;
}

export interface JournalActions {
  beginDataWipe: () => Promise<void>;
  closeSettings: () => Promise<void>;
  endDataWipe: () => void;
  importEntries: (
    entries: ParsedImport[],
    onEmbedProgress?: (done: number, total: number) => void
  ) => Promise<number>;
  refreshAfterDataWipe: () => Promise<void>;
  runStaleEmbeddingPass: () => Promise<boolean>;
  select: (id: number) => Promise<void>;
  setDetailOpen: (open: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  showChat: () => Promise<void>;
  showHome: () => Promise<void>;
  showJournal: () => Promise<void>;
  showMemories: () => Promise<void>;
  showNavMenu: () => void;
  showSettings: () => Promise<void>;
  startDraft: () => Promise<void>;
}

export interface EntryState {
  date: string;
  deleteOpen: boolean;
  deleteTitle: string;
  loading: boolean;
  saveLabel: string;
  title: string;
  updatedAt: string;
}

export interface EntryActions {
  changeTitle: (title: string) => void;
  confirmDelete: () => Promise<void>;
  flush: () => Promise<void>;
  openDelete: () => void;
  openDeleteEntry: (id: number) => void;
  registerEditor: (adapter: EditorAdapter | null) => void;
  scheduleSave: () => void;
  setDeleteOpen: (open: boolean) => void;
}

export interface JournalContextValue {
  actions: JournalActions;
  meta: Record<string, never>;
  state: JournalState;
}

export interface EntryContextValue {
  actions: EntryActions;
  meta: Record<string, never>;
  state: EntryState;
}

const JournalContext = createContext<JournalContextValue | null>(null);
const EntryContext = createContext<EntryContextValue | null>(null);

export function useJournal(): JournalContextValue {
  const value = use(JournalContext);
  if (!value) {
    throw new Error("JournalProvider is missing.");
  }
  return value;
}

export function useEntry(): EntryContextValue {
  const value = use(EntryContext);
  if (!value) {
    throw new Error("JournalProvider is missing.");
  }
  return value;
}

export function JournalStateProvider({
  children,
  entry,
  journal,
}: {
  children: ReactNode;
  entry: EntryContextValue;
  journal: JournalContextValue;
}) {
  return (
    <JournalContext value={journal}>
      <EntryContext value={entry}>{children}</EntryContext>
    </JournalContext>
  );
}
