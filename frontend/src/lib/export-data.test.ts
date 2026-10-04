import assert from "node:assert/strict";
import test from "node:test";

import {
  type DataExportDependencies,
  type DataExportNotifications,
  dataExportSuccessMessage,
  exportDataWithNotifications,
  runDataExport,
} from "./export-data-flow.ts";

function dependencies(
  overrides: Partial<DataExportDependencies> = {}
): DataExportDependencies {
  return {
    chatList: () => Promise.resolve([]),
    exportData: () => Promise.resolve({ conversations: 0, entries: 0 }),
    listEntries: () => Promise.resolve([]),
    openExportDirectoryDialog: () => Promise.resolve("/tmp/export"),
    ...overrides,
  };
}

function notifications(messages: string[]): DataExportNotifications {
  return {
    empty: (message) => messages.push(`empty:${message}`),
    error: (message) => messages.push(`error:${message}`),
    success: (message) => messages.push(`success:${message}`),
  };
}

test("runDataExport skips the picker when there is no data", async () => {
  let pickerCalls = 0;
  const result = await runDataExport(
    dependencies({
      openExportDirectoryDialog: () => {
        pickerCalls += 1;
        return Promise.resolve("/tmp/export");
      },
    })
  );

  assert.deepEqual(result, { kind: "empty" });
  assert.equal(pickerCalls, 0);
});

test("runDataExport exports conversations even when the journal is empty", async () => {
  let exportedTo: string | null = null;
  const result = await runDataExport(
    dependencies({
      chatList: () =>
        Promise.resolve([{ id: 7, title: "Chat", updatedAt: "2026-09-30" }]),
      exportData: (destDir) => {
        exportedTo = destDir;
        return Promise.resolve({ conversations: 1, entries: 0 });
      },
    })
  );

  assert.deepEqual(result, { conversations: 1, entries: 0, kind: "ok" });
  assert.equal(exportedTo, "/tmp/export");
});

test("runDataExport returns cancellation without exporting", async () => {
  let exportCalls = 0;
  const result = await runDataExport(
    dependencies({
      exportData: () => {
        exportCalls += 1;
        return Promise.resolve({ conversations: 0, entries: 1 });
      },
      listEntries: () =>
        Promise.resolve([
          {
            date: "2026-09-30",
            format: "markdown",
            id: 1,
            title: "Entry",
            updatedAt: "2026-09-30",
            wordCount: 1,
          },
        ]),
      openExportDirectoryDialog: () => Promise.resolve(null),
    })
  );

  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(exportCalls, 0);
});

test("dataExportSuccessMessage reports entry and conversation counts", () => {
  assert.equal(
    dataExportSuccessMessage({ conversations: 1, entries: 2 }),
    "Exported 2 journal entries and 1 conversation."
  );
  assert.equal(
    dataExportSuccessMessage({ conversations: 3, entries: 1 }),
    "Exported 1 journal entry and 3 conversations."
  );
});

test("exportDataWithNotifications reports empty data and export errors", async () => {
  const messages: string[] = [];
  await exportDataWithNotifications(dependencies(), notifications(messages));
  await exportDataWithNotifications(
    dependencies({
      chatList: () =>
        Promise.resolve([{ id: 2, title: "Chat", updatedAt: "2026-09-30" }]),
      exportData: () =>
        Promise.reject(new Error("The export folder is unavailable.")),
    }),
    notifications(messages)
  );

  assert.deepEqual(messages, [
    "empty:Nothing to export.",
    "error:The export folder is unavailable.",
  ]);
});
