import { type Dirent, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadYaml } from "eve/evals/loaders";

import { resolveWhen } from "../../agent/lib/when.ts";
import { evalContentDir } from "./content.ts";
import { chatNeedStem, type PersonCase, parsePersonCase } from "./schema.ts";

const leadingBomPattern = /^﻿/u;
const lineBreakPattern = /\r?\n/u;
const turnMarkerPattern = /^(User|Sage):[ \t]*(.*)$/u;

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const frontmatterKeyPattern = /^(\w[\w-]*)\s*:\s*(.*)$/u;
const whitespacePattern = /\s+/u;
const markdownSuffixPattern = /\.md$/u;
const onlyDigitsPattern = /^\d+$/u;
const personIdPattern = /^[a-z0-9][a-z0-9-]*$/u;

/** `SAGE_EVAL_DATA` when it is set, else the content's `data` folder. */
export function evalDataRoot(): string {
  const fromEnv = process.env.SAGE_EVAL_DATA;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return evalContentDir("data");
}

export interface LoadedEntry {
  body: string;
  date: string;
  fileName: string;
  /** 1-based, in filename order. */
  index: number;
  /** The file name without `.md`. A ref in `case.yaml` can use it. */
  stem: string;
  title: string;
  wordCount: number;
}

/** The old name for a loaded entry, still imported by `scripts/automation.ts`. */
export type JournalEntryFixture = LoadedEntry;

/** One turn of a past chat. `user` is the person ("User:"), `assistant` is Sage ("Sage:"). */
export interface ChatTurn {
  role: "assistant" | "user";
  text: string;
}

/** An earlier chat with Sage, from `chats/<date>-<slug>.md`. */
export interface LoadedChat {
  date: string;
  fileName: string;
  /** 1-based, in filename order. */
  index: number;
  /** The file name without `.md`. A `needs` ref reaches it as `chat:<stem>`. */
  stem: string;
  title: string;
  turns: ChatTurn[];
  wordCount: number;
}

export interface LoadedPerson {
  /** Earlier chats with Sage, in filename order. Empty when there is no `chats/` folder. */
  chats: LoadedChat[];
  dir: string;
  /** No `.md` entries, so the journal is empty. */
  empty: boolean;
  entries: LoadedEntry[];
  id: string;
  personCase: PersonCase;
}

export interface Manifest {
  cases: Record<string, { chatIds?: number[]; journalIds: number[] }>;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function peopleDir(): string {
  return join(evalDataRoot(), "people");
}

/** Every person under `<root>/people/`, in id order. `only` limits it to those ids. */
export async function loadPeople(opts?: {
  only?: string[];
}): Promise<LoadedPerson[]> {
  const known = await listPeopleIds();
  const wanted = opts?.only;
  if (wanted !== undefined) {
    const missing = wanted.filter((id) => !known.includes(id));
    if (missing.length > 0) {
      throw new Error(
        `Unknown ${missing.length === 1 ? "person" : "people"} ${missing.map((id) => `"${id}"`).join(", ")}. Known: ${known.join(", ") || "(none)"}.`
      );
    }
  }
  const ids =
    wanted === undefined ? known : known.filter((id) => wanted.includes(id));
  return await Promise.all(ids.map((id) => loadPerson(id)));
}

export async function loadPerson(id: string): Promise<LoadedPerson> {
  if (!personIdPattern.test(id)) {
    throw new Error(
      `"${id}" is not a person id. Use lowercase letters, digits, and dashes.`
    );
  }
  const dir = join(peopleDir(), id);
  let doc: Record<string, unknown>;
  try {
    doc = await loadYaml(join(dir, "case.yaml"));
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${id} has no case.yaml. Looked in ${dir}.`, {
        cause: error,
      });
    }
    throw error;
  }
  const personCase = parsePersonCase(doc, `case.yaml for ${id}`);
  if (personCase.id !== id) {
    throw new Error(
      `${id}/case.yaml has id "${personCase.id}". The id must match the folder name.`
    );
  }
  const entries = await loadEntryFiles(dir);
  for (const entry of entries) {
    if (onlyDigitsPattern.test(entry.stem)) {
      throw new Error(
        `${id}/${entry.fileName} is named only with digits, so a ref to it reads as an entry number. Rename the file.`
      );
    }
  }
  const chats = await loadChatFiles(dir);
  return { chats, dir, empty: entries.length === 0, entries, id, personCase };
}

async function listPeopleIds(): Promise<string[]> {
  let found: Dirent[];
  try {
    found = await readdir(peopleDir(), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  return found
    .filter((item) => item.isDirectory() && !item.name.startsWith("."))
    .map((item) => item.name)
    .sort();
}

/**
 * The entry a `case.yaml` ref points at. A number counts from 1 in filename
 * order. A string is a file stem, such as `2026-06-15-told-sam`.
 */
export function resolveEntry(
  person: LoadedPerson,
  ref: number | string
): LoadedEntry {
  const count = person.entries.length;
  if (count === 0) {
    throw new Error(
      `${person.id} has an empty journal, so there is no entry ${JSON.stringify(ref)}.`
    );
  }
  if (typeof ref === "number") {
    const entry = Number.isInteger(ref) ? person.entries[ref - 1] : undefined;
    if (ref < 1 || entry === undefined) {
      throw new Error(
        `${person.id} has no entry number ${ref}. Entries are numbered 1 to ${count}.`
      );
    }
    return entry;
  }
  const entry = person.entries.find((candidate) => candidate.stem === ref);
  if (entry === undefined) {
    const hint = markdownSuffixPattern.test(ref)
      ? " Leave off .md."
      : ` A stem looks like "${person.entries[0]?.stem}".`;
    throw new Error(`${person.id} has no entry with the stem "${ref}".${hint}`);
  }
  return entry;
}

/**
 * The past chat a `chat:<stem>` ref points at. Pass the stem, or the whole ref.
 */
export function resolveChat(
  person: Pick<LoadedPerson, "chats" | "id">,
  ref: string
): LoadedChat {
  const stem = chatNeedStem(ref) ?? ref;
  if (person.chats.length === 0) {
    throw new Error(
      `${person.id} has no past chats, so there is no chat "${stem}".`
    );
  }
  const chat = person.chats.find((candidate) => candidate.stem === stem);
  if (chat === undefined) {
    const hint = markdownSuffixPattern.test(stem)
      ? " Leave off .md."
      : ` A stem looks like "${person.chats[0]?.stem}".`;
    throw new Error(
      `${person.id} has no past chat with the stem "${stem}".${hint}`
    );
  }
  return chat;
}

/** What a `needs` ref points at: an entry, or a past chat written as `chat:<stem>`. */
export type ResolvedNeed =
  | { chat: LoadedChat; kind: "chat" }
  | { entry: LoadedEntry; kind: "entry" };

/** Resolves one `needs` ref. Throws a readable error when nothing matches. */
export function resolveNeed(
  person: LoadedPerson,
  ref: number | string
): ResolvedNeed {
  if (chatNeedStem(ref) !== null) {
    return { chat: resolveChat(person, String(ref)), kind: "chat" };
  }
  return { entry: resolveEntry(person, ref), kind: "entry" };
}

// ---------------------------------------------------------------------------
// Checks on a loaded person
// ---------------------------------------------------------------------------

/**
 * Problems in a person's files, one line each, as of `today`. An empty list
 * means the person is sound.
 *
 * - An entry or a past chat is dated after `today`.
 * - A past chat's turns do not alternate, starting with the person.
 * - A ref in `events`, `summaries`, `retrieval`, `chat`, `openers`, or the
 *   `script` of a conversation names no entry. A `needs` ref written
 *   `chat:<stem>` names a past chat instead.
 * - An opener, a conversation, or a scripted turn that also runs on the empty
 *   journal says `search: needed`, which expects a hit that journal cannot give.
 * - A retrieval item with `when` expects an entry outside the days that phrase
 *   covers on `today`, read the way `search_journal` reads it.
 */
export function validatePerson(person: LoadedPerson, today: string): string[] {
  if (!isRealDate(today)) {
    return [`Today must be a YYYY-MM-DD date, not "${today}".`];
  }
  return [
    ...datingProblems(person, today),
    ...answerKeyProblems(person, today),
    ...needsProblems(person),
  ];
}

/** Entries and past chats dated after `today`, and past chats whose turns do not alternate. */
function datingProblems(person: LoadedPerson, today: string): string[] {
  const problems: string[] = [];
  for (const entry of person.entries) {
    if (entry.date > today) {
      problems.push(
        `${entry.fileName} is dated ${entry.date}, after ${today}.`
      );
    }
  }
  for (const chat of person.chats) {
    if (chat.date > today) {
      problems.push(
        `chats/${chat.fileName} is dated ${chat.date}, after ${today}.`
      );
    }
    const alternation = alternationProblem(chat);
    if (alternation !== undefined) {
      problems.push(`chats/${chat.fileName}: ${alternation}`);
    }
  }
  return problems;
}

/** Refs in `events`, `summaries`, and `retrieval` that match no entry, and `when` windows that miss. */
function answerKeyProblems(person: LoadedPerson, today: string): string[] {
  const problems: string[] = [];
  const { personCase } = person;
  for (const [index, item] of personCase.events.entries()) {
    lookUp(person, `events[${index}].entry`, item.entry, problems);
  }
  for (const [index, item] of personCase.summaries.entries()) {
    lookUp(person, `summaries[${index}].entry`, item.entry, problems);
  }
  for (const [index, item] of personCase.retrieval.entries()) {
    const label = `retrieval[${index}] (query "${item.query}")`;
    const expected = lookUp(
      person,
      `${label} expectEntry`,
      item.expectEntry,
      problems
    );
    if (expected !== undefined && item.when !== undefined) {
      const problem = whenProblem(label, item.when, expected, today);
      if (problem !== undefined) {
        problems.push(problem);
      }
    }
  }
  return problems;
}

/** `needs` refs that match nothing, and openers that expect a hit on the empty journal. */
function needsProblems(person: LoadedPerson): string[] {
  const problems: string[] = [];
  const { personCase } = person;
  for (const [index, item] of personCase.chat.entries()) {
    for (const ref of item.needs) {
      lookUpNeed(person, `chat[${index}].needs`, ref, problems);
    }
  }
  for (const item of personCase.openers) {
    for (const ref of item.needs) {
      lookUpNeed(person, `openers (in ${item.id}).needs`, ref, problems);
    }
    if (item.alsoEmpty && item.search === "needed") {
      problems.push(
        `openers (in ${item.id}): alsoEmpty is set, but search is needed. The empty journal has nothing to find, so use search none or optional, or take alsoEmpty off.`
      );
    }
  }
  for (const item of personCase.conversations) {
    problems.push(...conversationNeedsProblems(person, item));
  }
  return problems;
}

/** The `needs` of a conversation's script that match nothing, and a search that cannot be met on the empty journal. */
function conversationNeedsProblems(
  person: LoadedPerson,
  item: LoadedPerson["personCase"]["conversations"][number]
): string[] {
  const problems: string[] = [];
  const noHit =
    "alsoEmpty is set, but search is needed. The empty journal has nothing to find, so use search none or optional, or take alsoEmpty off.";
  if (item.alsoEmpty && item.search === "needed") {
    problems.push(`conversations (in ${item.id}): ${noHit}`);
  }
  for (const [turn, entry] of Object.entries(item.script ?? {})) {
    for (const ref of entry.needs) {
      lookUpNeed(
        person,
        `conversations (in ${item.id}).script.${turn}.needs`,
        ref,
        problems
      );
    }
    if (item.alsoEmpty && entry.search === "needed") {
      problems.push(`conversations (in ${item.id}).script.${turn}: ${noHit}`);
    }
  }
  return problems;
}

/** Why a chat's turns do not alternate, starting with the person, or undefined when they do. */
function alternationProblem(chat: LoadedChat): string | undefined {
  for (const [index, turn] of chat.turns.entries()) {
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (turn.role !== expected) {
      const marker = expected === "user" ? "User:" : "Sage:";
      return `turn ${index + 1} should start with ${marker}. Turns alternate, starting with User:.`;
    }
  }
  return undefined;
}

function lookUpNeed(
  person: LoadedPerson,
  label: string,
  ref: number | string,
  problems: string[]
): void {
  try {
    resolveNeed(person, ref);
  } catch (error) {
    problems.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function lookUp(
  person: LoadedPerson,
  label: string,
  ref: number | string,
  problems: string[]
): LoadedEntry | undefined {
  try {
    return resolveEntry(person, ref);
  } catch (error) {
    problems.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function whenProblem(
  label: string,
  when: string,
  expected: LoadedEntry,
  today: string
): string | undefined {
  const resolved = resolveWhen(when, today);
  if ("error" in resolved) {
    return `${label}: when "${when}" does not read as a time. ${resolved.error}`;
  }
  const { from, to } = resolved.range;
  if (expected.date >= from && expected.date <= to) {
    return undefined;
  }
  return `${label}: when "${when}" covers ${from} to ${to} on ${today}, but ${expected.fileName} is dated ${expected.date}.`;
}

function isRealDate(value: string): boolean {
  if (!isoDatePattern.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// ---------------------------------------------------------------------------
// Journal-id manifest
// ---------------------------------------------------------------------------

/** Reads the journal ids that `make eval` wrote when it seeded the journals. */
export function loadManifest(path?: string): Manifest {
  const file = path ?? process.env.SAGE_EVAL_MANIFEST;
  if (file === undefined || file.length === 0) {
    throw new Error(
      "SAGE_EVAL_MANIFEST is not set. Run make eval so the seed step can write journal ids."
    );
  }
  return readManifestSync(file);
}

export function journalIdFor(
  manifest: Manifest,
  personId: string,
  entry: LoadedEntry
): number {
  const ids = manifest.cases[personId]?.journalIds;
  if (ids === undefined) {
    throw new Error(`Manifest has no journal ids for ${personId}.`);
  }
  const id = ids[entry.index - 1];
  if (id === undefined) {
    throw new Error(
      `${personId} has no journal id for entry ${entry.index} (${entry.stem}).`
    );
  }
  return id;
}

/** The id Sage gave a past chat when the seed step saved it. */
export function chatIdFor(
  manifest: Manifest,
  personId: string,
  chat: Pick<LoadedChat, "index" | "stem">
): number {
  const entry = manifest.cases[personId];
  if (entry === undefined) {
    throw new Error(`Manifest has no ids for ${personId}.`);
  }
  const id = entry.chatIds?.[chat.index - 1];
  if (id === undefined) {
    throw new Error(
      `${personId} has no chat id for past chat ${chat.index} (${chat.stem}).`
    );
  }
  return id;
}

function readManifestSync(path: string): Manifest {
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
  const cases: Manifest["cases"] = {};
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
    const chatIds = "chatIds" in value ? value.chatIds : undefined;
    if (
      chatIds !== undefined &&
      !(
        Array.isArray(chatIds) &&
        chatIds.every((item) => typeof item === "number")
      )
    ) {
      throw new Error(
        `Eval manifest case ${id} has chatIds that are not numbers.`
      );
    }
    cases[id] =
      chatIds === undefined
        ? { journalIds: value.journalIds }
        : { chatIds, journalIds: value.journalIds };
  }
  return { cases };
}

// ---------------------------------------------------------------------------
// Entry files
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): {
  body: string;
  date?: string;
  title?: string;
} {
  const lines = content.replace(leadingBomPattern, "").split(lineBreakPattern);
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

/**
 * Reads the `*.md` files at the top of a folder, in filename order. Other
 * files and folders, such as `case.yaml` and `chats/`, are left alone. A folder
 * with no entries gives an empty list.
 */
export async function loadEntryFiles(dir: string): Promise<LoadedEntry[]> {
  const found = await readdir(dir, { withFileTypes: true });
  const names = found
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => item.name)
    .sort();
  const files = await Promise.all(
    names.map(async (fileName) => ({
      fileName,
      raw: await readFile(join(dir, fileName), "utf8"),
    }))
  );
  const entries: LoadedEntry[] = [];
  for (const [offset, { fileName, raw }] of files.entries()) {
    const parsed = parseFrontmatter(raw);
    const body = parsed.body.trim();
    const date = parsed.date?.trim() ?? "";
    const title = parsed.title?.trim() ?? "";
    if (!(isoDatePattern.test(date) && isRealDate(date))) {
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
      stem: fileName.replace(markdownSuffixPattern, ""),
      title,
      wordCount: countWords(body),
    });
  }
  return entries;
}

/**
 * Splits the body of a chat file into turns. A turn starts at the beginning of
 * a line with `User:` or `Sage:`. Lines after it, up to the next marker, are
 * part of the same turn. Text before the first marker, and a turn with no
 * text, are errors.
 */
export function parseChatTurns(body: string): ChatTurn[] {
  const turns: { role: ChatTurn["role"]; lines: string[] }[] = [];
  for (const line of body.split(lineBreakPattern)) {
    const marker = turnMarkerPattern.exec(line);
    if (marker !== null) {
      turns.push({
        lines: [marker[2] ?? ""],
        role: marker[1] === "User" ? "user" : "assistant",
      });
      continue;
    }
    const current = turns.at(-1);
    if (current !== undefined) {
      current.lines.push(line);
    } else if (line.trim().length > 0) {
      throw new Error(
        `text before the first "User:" or "Sage:" line: "${line.trim().slice(0, 40)}".`
      );
    }
  }
  return turns.map((turn, index) => {
    const text = turn.lines.join("\n").trim();
    if (text.length === 0) {
      throw new Error(`turn ${index + 1} has no text.`);
    }
    return { role: turn.role, text };
  });
}

/**
 * Reads the `*.md` files in a person's `chats/` folder, in filename order. A
 * file has `date` and `title` in its frontmatter and `User:` and `Sage:` turns
 * in its body. A person with no `chats/` folder has no past chats.
 */
export async function loadChatFiles(personDir: string): Promise<LoadedChat[]> {
  const dir = join(personDir, "chats");
  let found: Dirent[];
  try {
    found = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const names = found
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => item.name)
    .sort();
  const files = await Promise.all(
    names.map(async (fileName) => ({
      fileName,
      raw: await readFile(join(dir, fileName), "utf8"),
    }))
  );
  return files.map(({ fileName, raw }, offset) => {
    const label = `chats/${fileName}`;
    const parsed = parseFrontmatter(raw);
    const date = parsed.date?.trim() ?? "";
    const title = parsed.title?.trim() ?? "";
    if (!(isoDatePattern.test(date) && isRealDate(date))) {
      throw new Error(`${label} needs a YYYY-MM-DD date in frontmatter.`);
    }
    if (title.length === 0) {
      throw new Error(`${label} needs a title in frontmatter.`);
    }
    let turns: ChatTurn[];
    try {
      turns = parseChatTurns(parsed.body);
    } catch (error) {
      throw new Error(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    if (turns.length === 0) {
      throw new Error(`${label} has no User: or Sage: turns.`);
    }
    return {
      date,
      fileName,
      index: offset + 1,
      stem: fileName.replace(markdownSuffixPattern, ""),
      title,
      turns,
      wordCount: turns.reduce((sum, turn) => sum + countWords(turn.text), 0),
    };
  });
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
