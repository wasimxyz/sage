export interface ExportCounts {
  conversations: number;
  entries: number;
}

export type DataExportResult =
  | { kind: "cancelled" }
  | { kind: "empty" }
  | ({ kind: "ok" } & ExportCounts);

export interface DataExportDependencies {
  chatList: () => Promise<readonly unknown[]>;
  exportData: (destDir: string) => Promise<ExportCounts>;
  listEntries: () => Promise<readonly unknown[]>;
  openExportDirectoryDialog: () => Promise<string | null>;
}

export interface DataExportNotifications {
  empty: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

export async function runDataExport(
  dependencies: DataExportDependencies
): Promise<DataExportResult> {
  const [entries, conversations] = await Promise.all([
    dependencies.listEntries(),
    dependencies.chatList(),
  ]);
  if (entries.length === 0 && conversations.length === 0) {
    return { kind: "empty" };
  }

  const destDir = await dependencies.openExportDirectoryDialog();
  if (destDir === null) {
    return { kind: "cancelled" };
  }

  const counts = await dependencies.exportData(destDir);
  return { ...counts, kind: "ok" };
}

export function dataExportSuccessMessage(counts: ExportCounts): string {
  const entryLabel = counts.entries === 1 ? "journal entry" : "journal entries";
  const conversationLabel =
    counts.conversations === 1 ? "conversation" : "conversations";
  return `Exported ${counts.entries} ${entryLabel} and ${counts.conversations} ${conversationLabel}.`;
}

export async function exportDataWithNotifications(
  dependencies: DataExportDependencies,
  notifications: DataExportNotifications
): Promise<void> {
  try {
    const result = await runDataExport(dependencies);
    if (result.kind === "empty") {
      notifications.empty("Nothing to export.");
      return;
    }
    if (result.kind === "cancelled") {
      return;
    }
    notifications.success(dataExportSuccessMessage(result));
  } catch (error: unknown) {
    notifications.error(
      error instanceof Error ? error.message : "Could not export Sage."
    );
  }
}
