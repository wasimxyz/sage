export interface FactRecord {
  fact: string;
  id: number;
  subject?: string;
}

export interface FactDraft {
  id?: number;
  key: string;
  text: string;
}

export interface FactEditSave {
  fact: string;
  id?: number;
  subject?: string;
}

export interface FactEditPlan {
  deletes: number[];
  saves: FactEditSave[];
}

export function draftsFromRecords(records: FactRecord[]): FactDraft[] {
  if (records.length === 0) {
    return [emptyDraft()];
  }
  return records.map((record) => ({
    id: record.id,
    key: `fact-${record.id}`,
    text: record.fact,
  }));
}

export function insertDraftAfter(
  drafts: FactDraft[],
  index: number
): { drafts: FactDraft[]; key: string } {
  const draft = emptyDraft();
  const next = [...drafts];
  const insertAt = Math.min(Math.max(index + 1, 0), drafts.length);
  next.splice(insertAt, 0, draft);
  return { drafts: next, key: draft.key };
}

export function appendDraft(drafts: FactDraft[]): {
  drafts: FactDraft[];
  key: string;
} {
  return insertDraftAfter(drafts, drafts.length - 1);
}

export function removeDraft(
  drafts: FactDraft[],
  key: string
): { drafts: FactDraft[]; focusKey: string | null } {
  if (drafts.length <= 1) {
    const [only] = drafts;
    if (only === undefined) {
      return { drafts, focusKey: null };
    }
    return { drafts: [{ ...only, text: "" }], focusKey: only.key };
  }
  const index = drafts.findIndex((draft) => draft.key === key);
  if (index < 0) {
    return { drafts, focusKey: null };
  }
  const next = drafts.filter((draft) => draft.key !== key);
  const focus = next[Math.max(0, index - 1)];
  return { drafts: next, focusKey: focus?.key ?? null };
}

export function planFactEdits(
  original: FactRecord[],
  drafts: FactDraft[],
  defaultSubject?: string
): FactEditPlan {
  const originalById = new Map(original.map((row) => [row.id, row]));
  const seenIds = new Set<number>();
  const saves: FactEditSave[] = [];
  const deletes: number[] = [];

  for (const draft of drafts) {
    const fact = draft.text.trim();
    if (draft.id === undefined) {
      if (fact.length > 0) {
        saves.push(saveFrom(fact, undefined, defaultSubject));
      }
      continue;
    }
    seenIds.add(draft.id);
    if (fact.length === 0) {
      deletes.push(draft.id);
      continue;
    }
    const previous = originalById.get(draft.id);
    if (previous === undefined) {
      saves.push(saveFrom(fact, draft.id, defaultSubject));
      continue;
    }
    if (previous.fact.trim() !== fact) {
      saves.push(saveFrom(fact, draft.id, previous.subject ?? defaultSubject));
    }
  }

  for (const row of original) {
    if (!seenIds.has(row.id)) {
      deletes.push(row.id);
    }
  }

  return { deletes, saves };
}

export function factEditsCanSave(
  original: FactRecord[],
  drafts: FactDraft[]
): boolean {
  const hasText = drafts.some((draft) => draft.text.trim().length > 0);
  if (!hasText) {
    return false;
  }
  const plan = planFactEdits(original, drafts);
  return plan.deletes.length > 0 || plan.saves.length > 0;
}

function saveFrom(
  fact: string,
  id: number | undefined,
  subject: string | undefined
): FactEditSave {
  if (subject === undefined) {
    return id === undefined ? { fact } : { fact, id };
  }
  return id === undefined ? { fact, subject } : { fact, id, subject };
}

function emptyDraft(): FactDraft {
  return { key: crypto.randomUUID(), text: "" };
}
