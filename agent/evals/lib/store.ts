import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { searchJournal } from "./sage.ts";

export function evalDataDir(): string {
  const dir = process.env.SAGE_DATA_DIR;
  if (dir === undefined || dir.length === 0) {
    throw new Error("SAGE_DATA_DIR is not set.");
  }
  return dir;
}

export function readEntrySummary(entryId: number): string | null {
  const db = new DatabaseSync(join(evalDataDir(), "app.db"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT summary FROM entry_summary WHERE entry_id = ?")
      .get(entryId) as { summary?: unknown } | undefined;
    if (row === undefined || typeof row.summary !== "string") {
      return null;
    }
    if (row.summary.startsWith("sage:v1:")) {
      throw new Error(
        `Entry ${entryId} summary is encrypted. Eval runs must use a throwaway journal with encryption off.`
      );
    }
    return row.summary;
  } finally {
    db.close();
  }
}

export async function summaryForEntry(
  entryId: number,
  title: string
): Promise<string | null> {
  const stored = readEntrySummary(entryId);
  if (stored !== null && stored.length > 0) {
    return stored;
  }
  const hits = await searchJournal(title, 25);
  return hits.find((hit) => hit.id === entryId)?.snippet ?? null;
}
