import { toast } from "sonner";

import {
  chatList,
  exportData,
  listEntries,
  openExportDirectoryDialog,
} from "@/bridge";
import {
  type DataExportDependencies,
  type DataExportNotifications,
  exportDataWithNotifications,
} from "./export-data-flow";
import { commitAll } from "./pending-deletes";

// Deletes that are still in their undo window run first, so the export does
// not include rows the owner has already deleted.
const nativeDataExportDependencies: DataExportDependencies = {
  chatList: async () => {
    await commitAll("chat");
    return chatList();
  },
  exportData,
  listEntries: async () => {
    await commitAll("entry");
    return listEntries();
  },
  openExportDirectoryDialog,
};

const dataExportNotifications: DataExportNotifications = {
  empty: (message) => {
    toast(message);
  },
  error: (message) => {
    toast.error(message);
  },
  success: (message) => {
    toast.success(message);
  },
};

export function exportDataWithToast(
  dependencies: DataExportDependencies = nativeDataExportDependencies,
  notifications: DataExportNotifications = dataExportNotifications
): Promise<void> {
  return exportDataWithNotifications(dependencies, notifications);
}
