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

const nativeDataExportDependencies: DataExportDependencies = {
  chatList,
  exportData,
  listEntries,
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
