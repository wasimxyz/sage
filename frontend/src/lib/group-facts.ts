import type { FactMemory } from "@/bridge";

export interface FactSubjectGroup {
  facts: FactMemory[];
  key: string;
  snippet: string;
  subject: string;
  updatedAt: string;
}

export function factSubjectKey(subject: string): string {
  return subject.trim().toLowerCase();
}

export function displaySubject(subject: string): string {
  const trimmed = subject.trim();
  return trimmed.length === 0 ? "Fact" : trimmed;
}

export function groupFactsBySubject(facts: FactMemory[]): FactSubjectGroup[] {
  const groups = new Map<string, FactMemory[]>();
  for (const fact of facts) {
    const key = factSubjectKey(fact.subject);
    const existing = groups.get(key);
    if (existing) {
      existing.push(fact);
      continue;
    }
    groups.set(key, [fact]);
  }
  const result: FactSubjectGroup[] = [];
  for (const [key, rows] of groups) {
    rows.sort(compareFactRecency);
    const [newest] = rows;
    result.push({
      facts: rows,
      key,
      snippet: newest?.fact ?? "",
      subject: displaySubject(newest?.subject ?? ""),
      updatedAt: newest?.updatedAt ?? "",
    });
  }
  result.sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt));
  return result;
}

function compareFactRecency(left: FactMemory, right: FactMemory): number {
  const byDate = compareIsoDesc(left.updatedAt, right.updatedAt);
  if (byDate !== 0) {
    return byDate;
  }
  return right.id - left.id;
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

export function groupForSubjectKey(
  facts: FactMemory[],
  key: string
): FactSubjectGroup | null {
  return groupFactsBySubject(facts).find((group) => group.key === key) ?? null;
}
