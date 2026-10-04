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
  const exportBusy = useRef(false as boolean);

  const openImport = useCallback(() => {
    setImportOpen(true);
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
    () => ({ openImport, setImportOpen }),
    [openImport]
  );
  const value = useMemo<FileMenuContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return (
    <FileMenuContext value={value}>
      {children}
      <ImportDialog onOpenChange={setImportOpen} open={importOpen} />
    </FileMenuContext>
  );
}
