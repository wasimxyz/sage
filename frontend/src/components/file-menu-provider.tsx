import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { onJournalExport, onJournalImport } from "@/bridge";
import { ImportDialog } from "@/components/import-dialog";
import { exportDataWithToast } from "@/lib/export-data";

interface FileMenuState {
  importOpen: boolean;
}

interface FileMenuActions {
  openImport: () => void;
  /**
   * Open the file picker at once and show the import preview. `onImported`
   * runs with the number of entries saved, after an import finishes.
   */
  pickAndImport: (onImported: (count: number) => void) => void;
  setImportOpen: (open: boolean) => void;
}

interface FileMenuContextValue {
  actions: FileMenuActions;
  meta: Record<string, never>;
  state: FileMenuState;
}

const FileMenuContext = createContext<FileMenuContextValue | null>(null);
const emptyMeta = {};

export function useFileMenu(): FileMenuContextValue {
  const value = use(FileMenuContext);
  if (!value) {
    throw new Error("FileMenuProvider is missing.");
  }
  return value;
}

export function FileMenuProvider({ children }: { children: ReactNode }) {
  const [importOpen, setImportOpen] = useState(false);
  const [pickFirst, setPickFirst] = useState(false);
  const onImported = useRef<((count: number) => void) | null>(null);
  const exportBusy = useRef(false as boolean);

  const openImport = useCallback(() => {
    onImported.current = null;
    setPickFirst(false);
    setImportOpen(true);
  }, []);

  const pickAndImport = useCallback((done: (count: number) => void) => {
    onImported.current = done;
    setPickFirst(true);
    setImportOpen(true);
  }, []);

  const handleImported = useCallback((count: number) => {
    const done = onImported.current;
    onImported.current = null;
    done?.(count);
  }, []);

  const runExport = useCallback(() => {
    if (exportBusy.current) {
      return;
    }
    exportBusy.current = true;
    exportDataWithToast().finally(() => {
      exportBusy.current = false;
    });
  }, []);

  useEffect(() => onJournalImport(openImport), [openImport]);
  useEffect(() => onJournalExport(runExport), [runExport]);

  const state = useMemo<FileMenuState>(() => ({ importOpen }), [importOpen]);
  const actions = useMemo<FileMenuActions>(
    () => ({ openImport, pickAndImport, setImportOpen }),
    [openImport, pickAndImport]
  );
  const value = useMemo<FileMenuContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return (
    <FileMenuContext value={value}>
      {children}
      <ImportDialog
        onImported={handleImported}
        onOpenChange={setImportOpen}
        open={importOpen}
        pickFirst={pickFirst}
      />
    </FileMenuContext>
  );
}
