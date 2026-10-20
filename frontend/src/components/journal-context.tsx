import { createContext, type ReactNode, use } from "react";

import type { JournalEntry, JournalEntryMeta } from "@/bridge";
import type { ParsedImport } from "@/lib/parse-markdown";

export type Section = "chat" | "home" | "journal" | "memories" | "settings";

export type SidebarMenu = "nav" | "settings";

export type EditorSelection = { kind: "id"; id: number } | { kind: "draft" };

export interface EditorAdapter {
  getBody: () => string;
  getText: () => string;
  isReady: () => boolean;
  loadDoc: (entry: JournalEntry) => void;
  resetDraft: () => void;
}

/**
 * Where the owner is: which screen, which entry, and how it is laid out. It
 * changes when they move around, not on each autosave. A new entry's first
 * save is the one exception: it gives the draft an id.
 */
export interface JournalViewState {
  detailOpen: boolean;
  expanded: boolean;
  section: Section;
  selectedId: number | null;
  selection: EditorSelection | null;
  sidebarMenu: SidebarMenu;
}

/** The entry list. It changes on every save, so only the list should read it. */
export interface JournalEntriesState {
  entries: JournalEntryMeta[];
  loadingList: boolean;
}

export interface JournalActions {
  beginDataWipe: () => Promise<void>;
  closeSettings: () => Promise<void>;
  /**
   * Hide an entry now and delete it when the undo toast closes. Stable, so
   * list rows can be memoized.
   */
  deleteEntry: (id: number) => void;
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
  loading: boolean;
  title: string;
  updatedAt: string;
}

export interface EntryActions {
  changeTitle: (title: string) => void;
  /** Delete the open entry with an undo. A draft that never saved just closes. */
  deleteOpenEntry: () => void;
  /** Save now. Resolves true when nothing is left unsaved. */
  flush: () => Promise<boolean>;
  registerEditor: (adapter: EditorAdapter | null) => void;
  scheduleSave: () => void;
}

export interface EntryContextValue {
  actions: EntryActions;
  meta: Record<string, never>;
  state: EntryState;
}

// Each slice has its own context, so a component redraws only for the part it
// reads. Saving the open entry changes the list and the open entry, not the
// view or the actions. `useEntry` still returns the whole open entry at once.
const JournalActionsContext = createContext<JournalActions | null>(null);
const JournalViewContext = createContext<JournalViewState | null>(null);
const JournalEntriesContext = createContext<JournalEntriesState | null>(null);
const EntryContext = createContext<EntryContextValue | null>(null);
const EntryActionsContext = createContext<EntryActions | null>(null);
const EntryLoadingContext = createContext<boolean | null>(null);

function present<T>(value: T | null): T {
  if (value === null) {
    throw new Error("JournalProvider is missing.");
  }
  return value;
}

/** Only the actions. They do not change on an autosave. */
export function useJournalActions(): JournalActions {
  return present(use(JournalActionsContext));
}

/** Only the view: section, selection, and layout. */
export function useJournalView(): JournalViewState {
  return present(use(JournalViewContext));
}

/** Only the entry list. */
export function useJournalEntries(): JournalEntriesState {
  return present(use(JournalEntriesContext));
}

export function useEntry(): EntryContextValue {
  return present(use(EntryContext));
}

/** Only the actions of the open entry. */
export function useEntryActions(): EntryActions {
  return present(use(EntryActionsContext));
}

/** Only whether the open entry is still loading. It does not change on a save. */
export function useEntryLoading(): boolean {
  return present(use(EntryLoadingContext));
}

export function JournalStateProvider({
  actions,
  children,
  entries,
  entry,
  view,
}: {
  actions: JournalActions;
  children: ReactNode;
  entries: JournalEntriesState;
  entry: EntryContextValue;
  view: JournalViewState;
}) {
  return (
    <JournalActionsContext value={actions}>
      <JournalViewContext value={view}>
        <JournalEntriesContext value={entries}>
          <EntryActionsContext value={entry.actions}>
            <EntryLoadingContext value={entry.state.loading}>
              <EntryContext value={entry}>{children}</EntryContext>
            </EntryLoadingContext>
          </EntryActionsContext>
        </JournalEntriesContext>
      </JournalViewContext>
    </JournalActionsContext>
  );
}
