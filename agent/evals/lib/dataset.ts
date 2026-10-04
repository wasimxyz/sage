import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadYaml } from "eve/evals/loaders";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const frontmatterKeyPattern = /^(\w[\w-]*)\s*:\s*(.*)$/;
const whitespacePattern = /\s+/;
const bundledDataRoot = fileURLToPath(new URL("../data", import.meta.url));

export function evalDataRoot(): string {
  const fromEnv = process.env.SAGE_EVAL_DATA;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const repo = process.env.SAGE_REPO_ROOT;
  if (repo !== undefined && repo.length > 0) {
    return join(repo, "agent", "evals", "data");
  }
  return bundledDataRoot;
}

export type CaseKind = "timeline" | "standalone";

export interface JournalEntryFixture {
  body: string;
  date: string;
  fileName: string;
  index: number;
  title: string;
  wordCount: number;
}

export interface FactRef {
  reference: string;
  stale?: string;
  subject: string;
}

export interface EventRef {
  entry: number;
  reference: string;
}

export interface SummaryRef {
  entry: number;
  reference: string;
}

export interface RetrievalRef {
  expectEntry: number;
  query: string;
}

export interface ChatRef {
  expectTool?: boolean;
  question: string;
  reference: string;
}

export interface EvalCase {
  dir: string;
  entries: JournalEntryFixture[];
  events: EventRef[];
  facts: FactRef[];
  id: string;
  kind: CaseKind;
  retrieval: RetrievalRef[];
  chat: ChatRef[];
  summaries: SummaryRef[];
  tags: string[];
}

export interface EvalManifest {
  cases: Record<string, { journalIds: number[] }>;
}

export async function loadAllCases(): Promise<EvalCase[]> {
  const groups = ["timelines", "standalones"] as const;
  const cases: EvalCase[] = [];
  for (const group of groups) {
    const groupDir = join(evalDataRoot(), group);
    let names: string[] = [];
    try {
      names = await readdir(groupDir);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }
    names.sort();
    for (const name of names) {
      if (name.startsWith(".")) {
        continue;
      }
      const dir = join(groupDir, name);
      const loaded = await loadCaseDir(dir);
      if (loaded) {
        cases.push(loaded);
      }
    }
  }
  return cases;
}

export async function loadCaseDir(dir: string): Promise<EvalCase | null> {
  let doc: Record<string, unknown>;
  try {
    doc = await loadYaml(join(dir, "case.yaml"));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const entries = await loadEntryFiles(dir);
  return parseCase(dir, doc, entries);
}

export function parseFrontmatter(content: string): {
  body: string;
  date?: string;
  title?: string;
} {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return { body: content };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { body: content };
  }
  let date: string | undefined;
  let title: string | undefined;
  for (let index = 1; index < end; index += 1) {
    const match = frontmatterKeyPattern.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const key = match[1]?.toLowerCase();
    const value = stripQuotes((match[2] ?? "").trim());
    if (key === "title" && value.length > 0) {
      title = value;
    }
    if (key === "date" && value.length > 0) {
      date = value;
    }
  }
  return {
    body: lines.slice(end + 1).join("\n"),
    date,
    title,
  };
}

export function countWords(text: string): number {
  const parts = text.trim().split(whitespacePattern);
  if (parts.length === 1 && parts[0] === "") {
    return 0;
  }
  return parts.length;
}

export function loadManifest(): EvalManifest {
  const path = process.env.SAGE_EVAL_MANIFEST;
  if (path === undefined || path.length === 0) {
    throw new Error(
      "SAGE_EVAL_MANIFEST is not set. Run make eval so the seed step can write journal ids."
    );
  }
  return readManifestSync(path);
}

/** Throws unless `make eval` wrote journal ids for this run. */
export function requireSeededManifest(): EvalManifest {
  return loadManifest();
}

/** Throws unless this case's entry was seeded into the throwaway journal. */
export function requireSeededEntry(caseId: string, entryIndex: number): void {
  journalIdFor(requireSeededManifest(), caseId, entryIndex);
}

export function journalIdFor(
  manifest: EvalManifest,
  caseId: string,
  entryIndex: number
): number {
  const ids = manifest.cases[caseId]?.journalIds;
  if (ids === undefined) {
    throw new Error(`Manifest has no journal ids for ${caseId}.`);
  }
  const id = ids[entryIndex - 1];
  if (id === undefined) {
    throw new Error(`${caseId} has no journal id for entry ${entryIndex}.`);
  }
  return id;
}

export function tagsFor(fixture: EvalCase, pipeline: string): string[] {
  return [...new Set([...fixture.tags, fixture.kind, pipeline])];
}

function readManifestSync(path: string): EvalManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("cases" in parsed) ||
    parsed.cases === null ||
    typeof parsed.cases !== "object"
  ) {
    throw new Error("Eval manifest is missing a cases object.");
  }
  const cases: Record<string, { journalIds: number[] }> = {};
  for (const [id, value] of Object.entries(
    parsed.cases as Record<string, unknown>
  )) {
    if (
      value === null ||
      typeof value !== "object" ||
      !("journalIds" in value) ||
      !Array.isArray(value.journalIds) ||
      !value.journalIds.every((item) => typeof item === "number")
    ) {
      throw new Error(`Eval manifest case ${id} is missing journalIds.`);
    }
    cases[id] = { journalIds: value.journalIds };
  }
  return { cases };
}

async function loadEntryFiles(dir: string): Promise<JournalEntryFixture[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const entries: JournalEntryFixture[] = [];
  for (const [offset, fileName] of names.entries()) {
    const raw = await readFile(join(dir, fileName), "utf8");
    const parsed = parseFrontmatter(raw);
    const body = parsed.body.trim();
    const date = parsed.date?.trim() ?? "";
    const title = parsed.title?.trim() ?? "";
    if (!isoDatePattern.test(date)) {
      throw new Error(`${fileName} needs a YYYY-MM-DD date in frontmatter.`);
    }
    if (title.length === 0) {
      throw new Error(`${fileName} needs a title in frontmatter.`);
    }
    if (body.length === 0) {
      throw new Error(`${fileName} has an empty body.`);
    }
    entries.push({
      body,
      date,
      fileName,
      index: offset + 1,
      title,
      wordCount: countWords(body),
    });
  }
  if (entries.length === 0) {
    throw new Error(`${basename(dir)} has no markdown entries.`);
  }
  return entries;
}

function parseCase(
  dir: string,
  doc: Record<string, unknown>,
  entries: JournalEntryFixture[]
): EvalCase {
  const id = requiredString(doc, "id", dir);
  const kind = requiredString(doc, "kind", dir);
  if (kind !== "timeline" && kind !== "standalone") {
    throw new Error(`${id} kind must be timeline or standalone.`);
  }
  const folder = basename(dir);
  const tags = stringList(doc.tags);
  if (folder.includes("example") && !tags.includes("example")) {
    tags.push("example");
  }
  return {
    chat: parseChat(doc.chat, id, entries.length),
    dir,
    entries,
    events: parseEvents(doc.events, id, entries.length),
    facts: parseFacts(doc.facts, id),
    id,
    kind,
    retrieval: parseRetrieval(doc.retrieval, id, entries.length),
    summaries: parseSummaries(doc.summaries, id, entries.length),
    tags,
  };
}

function parseFacts(value: unknown, id: string): FactRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${id} facts must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${id} fact ${index + 1} must be a mapping.`);
    }
    const row = item as Record<string, unknown>;
    const subject = requiredString(row, "subject", `${id} fact ${index + 1}`);
    const reference = requiredString(row, "reference", `${id} fact ${index + 1}`);
    const stale =
      typeof row.stale === "string" && row.stale.length > 0
        ? row.stale
        : undefined;
    return { reference, stale, subject };
  });
}

function parseEvents(
  value: unknown,
  id: string,
  entryCount: number
): EventRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${id} events must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${id} event ${index + 1} must be a mapping.`);
    }
    const row = item as Record<string, unknown>;
    const entry = requiredEntry(row, `${id} event ${index + 1}`, entryCount);
    const reference = requiredString(
      row,
      "reference",
      `${id} event ${index + 1}`
    );
    return { entry, reference };
  });
}

function parseSummaries(
  value: unknown,
  id: string,
  entryCount: number
): SummaryRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${id} summaries must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${id} summary ${index + 1} must be a mapping.`);
    }
    const row = item as Record<string, unknown>;
    const entry = requiredEntry(row, `${id} summary ${index + 1}`, entryCount);
    const reference = requiredString(
      row,
      "reference",
      `${id} summary ${index + 1}`
    );
    return { entry, reference };
  });
}

function parseRetrieval(
  value: unknown,
  id: string,
  entryCount: number
): RetrievalRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${id} retrieval must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${id} retrieval ${index + 1} must be a mapping.`);
    }
    const row = item as Record<string, unknown>;
    const query = requiredString(row, "query", `${id} retrieval ${index + 1}`);
    const expectEntry = requiredInt(
      row,
      "expectEntry",
      `${id} retrieval ${index + 1}`
    );
    requireEntryIndex(expectEntry, entryCount, `${id} retrieval ${index + 1}`);
    return { expectEntry, query };
  });
}

function parseChat(value: unknown, id: string, _entryCount: number): ChatRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${id} chat must be a list.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`${id} chat ${index + 1} must be a mapping.`);
    }
    const row = item as Record<string, unknown>;
    const question = requiredString(
      row,
      "question",
      `${id} chat ${index + 1}`
    );
    const reference = requiredString(
      row,
      "reference",
      `${id} chat ${index + 1}`
    );
    const expectTool = row.expectTool === true;
    return { expectTool, question, reference };
  });
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value.trim();
}

function requiredInt(
  row: Record<string, unknown>,
  key: string,
  label: string
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} is missing integer ${key}.`);
  }
  return value;
}

function requiredEntry(
  row: Record<string, unknown>,
  label: string,
  entryCount: number
): number {
  const entry = requiredInt(row, "entry", label);
  requireEntryIndex(entry, entryCount, label);
  return entry;
}

function requireEntryIndex(
  entry: number,
  entryCount: number,
  label: string
): void {
  if (entry < 1 || entry > entryCount) {
    throw new Error(`${label} entry ${entry} is out of range.`);
  }
}

function stringList(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("tags must be a list of strings.");
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
