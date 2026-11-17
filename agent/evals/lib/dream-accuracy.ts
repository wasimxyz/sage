/**
 * Dream accuracy: what Dream wrote, grouped by the source it came from, and
 * graded once per source.
 *
 * The person pass reads the throwaway Sage's SQLite file read-only. Dream
 * writes these things, and each has a source:
 *
 * - an entry summary (source: the entry)
 * - a chat summary and a chat title (source: the chat)
 * - profile sentences, facts, and events (source: an entry or a chat; memory
 *   builds only)
 *
 * The judge sees one source next to everything Dream wrote from it, plus the
 * person's fact sheet as the truth, and returns each unsupported claim with a
 * severity. A `severe` claim (death, suicide, self-harm, abuse, violence)
 * fails the hard check `no-severe-unsupported`. An `other` claim is a counted
 * failure of `dream-supported` for the item Dream wrote that it is about.
 *
 * Everything that touches the world (the database, the manifest, the judge,
 * the cache) is passed in, so the tests run with a temp database and a mock
 * judge.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defineEval } from "eve/evals";

import { journalIdFor, loadManifest, type Manifest } from "./dataset.ts";
import {
  createGradeCache,
  type GradeCache,
  inputHashOf,
} from "./dream-grade-cache.ts";
import {
  type DreamSource,
  type DreamWritten,
  formatFactSheet,
} from "./dream-judge-input.ts";
import { dreamSourceCall, type Grader, sharedGrader } from "./grader.ts";
import { type EvalDefinition, type PersonPass, tagsFor } from "./pass.ts";
import {
  type ItemRef,
  itemMetadata,
  makeItem,
  recordCheck,
  type ScoreHost,
} from "./record.ts";
import type {
  DreamItemKind,
  DreamSourceReport,
  UnsupportedClaim,
} from "./schema.ts";
import { memoryOn } from "./setup.ts";
import { evalDataDir } from "./store.ts";

export const MEMORY_OFF_REASON =
  "Memory is off in this setup, so Dream wrote no facts, events, or profile.";
export const NOTHING_WRITTEN_REASON = "Dream wrote nothing from this source.";

const ENCRYPTED_PREFIX = "sage:v1:";
const CHAT_SOURCE_PREFIX = "chat-";

// ---------------------------------------------------------------------------
// Reading the database
// ---------------------------------------------------------------------------

export interface DreamChatRow {
  id: number;
  messages: { role: "assistant" | "user"; text: string }[];
  summary: string | null;
  title: string;
  /** True after a rename. Dream writes a title only when this is false. */
  titleLocked: boolean;
}

export interface DreamFactRow {
  fact: string;
  id: number;
  kind: "fact" | "profile";
  sourceId: number;
  sourceType: string;
  subject: string;
}

export interface DreamEventRow {
  event: string;
  id: number;
  occurredAt: string;
  sourceId: number;
  sourceType: string;
}

export interface DreamRows {
  chats: DreamChatRow[];
  entrySummaries: { entryId: number; summary: string }[];
  events: DreamEventRow[];
  facts: DreamFactRow[];
}

function plain(value: unknown, what: string): string {
  const text = typeof value === "string" ? value : "";
  if (text.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error(
      `${what} is encrypted. Eval runs must use a throwaway journal with encryption off.`
    );
  }
  return text;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** The text of a `message.received` or `message.completed` event, else null. */
export function chatMessageOf(
  raw: string
): { role: "assistant" | "user"; text: string } | null {
  if (
    !(raw.includes("message.received") || raw.includes("message.completed"))
  ) {
    return null;
  }
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (event === null || typeof event !== "object") {
    return null;
  }
  const { data, type } = event as { data?: unknown; type?: unknown };
  let role: "assistant" | "user";
  if (type === "message.received") {
    role = "user";
  } else if (type === "message.completed") {
    role = "assistant";
  } else {
    return null;
  }
  const message =
    data !== null && typeof data === "object"
      ? (data as { message?: unknown }).message
      : undefined;
  if (typeof message !== "string" || message.trim().length === 0) {
    return null;
  }
  return { role, text: message.trim() };
}

function readChats(db: DatabaseSync): DreamChatRow[] {
  const chats = db
    .prepare(
      "SELECT c.id AS id, c.title AS title, c.title_locked AS locked, s.summary AS summary FROM chat_conversation c LEFT JOIN chat_summary s ON s.conversation_id = c.id ORDER BY c.id"
    )
    .all() as Record<string, unknown>[];
  const events = db
    .prepare(
      "SELECT conversation_id AS id, event FROM chat_event ORDER BY conversation_id, seq"
    )
    .all() as Record<string, unknown>[];
  const messages = new Map<number, DreamChatRow["messages"]>();
  for (const row of events) {
    const message = chatMessageOf(plain(row.event, "A chat event"));
    if (message !== null) {
      const id = numberOf(row.id);
      messages.set(id, [...(messages.get(id) ?? []), message]);
    }
  }
  return chats.map((row) => {
    const id = numberOf(row.id);
    return {
      id,
      messages: messages.get(id) ?? [],
      summary:
        row.summary === null || row.summary === undefined
          ? null
          : plain(row.summary, `Chat ${id} summary`),
      title: plain(row.title, `Chat ${id} title`),
      titleLocked: numberOf(row.locked) === 1,
    };
  });
}

/**
 * Everything Dream wrote, read from `app.db` with the file opened read-only.
 * With `memory: false` the facts, events, and profile are not read at all.
 */
export function readDreamRows(
  dbPath: string,
  options: { memory: boolean }
): DreamRows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const entrySummaries = (
      db
        .prepare(
          "SELECT entry_id AS entryId, summary FROM entry_summary ORDER BY entry_id"
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      entryId: numberOf(row.entryId),
      summary: plain(row.summary, `Entry ${String(row.entryId)} summary`),
    }));
    const chats = readChats(db);
    if (!options.memory) {
      return { chats, entrySummaries, events: [], facts: [] };
    }
    const facts = (
      db
        .prepare(
          "SELECT id, kind, subject, fact, source_type AS sourceType, source_id AS sourceId FROM semantic_fact WHERE hidden = 0 ORDER BY id"
        )
        .all() as Record<string, unknown>[]
    ).map(
      (row): DreamFactRow => ({
        fact: plain(row.fact, `Fact ${String(row.id)}`),
        id: numberOf(row.id),
        kind: row.kind === "profile" ? "profile" : "fact",
        sourceId: numberOf(row.sourceId),
        sourceType: String(row.sourceType),
        subject: plain(row.subject, `Fact ${String(row.id)} subject`),
      })
    );
    const events = (
      db
        .prepare(
          "SELECT id, event, occurred_at AS occurredAt, source_type AS sourceType, source_id AS sourceId FROM episodic_event WHERE hidden = 0 ORDER BY id"
        )
        .all() as Record<string, unknown>[]
    ).map(
      (row): DreamEventRow => ({
        event: plain(row.event, `Event ${String(row.id)}`),
        id: numberOf(row.id),
        occurredAt: String(row.occurredAt ?? ""),
        sourceId: numberOf(row.sourceId),
        sourceType: String(row.sourceType),
      })
    );
    return { chats, entrySummaries, events, facts };
  } finally {
    db.close();
  }
}

/**
 * The ids of the chats in the database, or an empty list when there is no
 * database yet or it cannot be read. The eval file calls this at import, when
 * a pass for another person, or none, may not have a database.
 */
export function listChatIds(dbPath: string): number[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT id FROM chat_conversation ORDER BY id")
          .all() as Record<string, unknown>[]
      ).map((row) => numberOf(row.id));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Grouping by source
// ---------------------------------------------------------------------------

/** An entry of the person's journal, with the id Sage gave it. */
export interface EntrySource {
  body: string;
  date: string;
  journalId: number;
  stem: string;
  title: string;
}

/** `chat-12`, the name Sage gives a chat. */
export function chatSourceId(chatId: number): string {
  return `${CHAT_SOURCE_PREFIX}${chatId}`;
}

/** `person/dream/<entry stem or chat-N>` */
export function dreamItemId(person: string, sourceId: string): string {
  return `${person}/dream/${sourceId}`;
}

/** How an entry reads to the judge: the date and title, then the body. */
export function entrySourceText(entry: {
  body: string;
  date: string;
  title: string;
}): string {
  return `${entry.date}, "${entry.title}"\n\n${entry.body.trim()}`;
}

function chatText(chat: DreamChatRow): string {
  return chat.messages
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Sage"}: ${message.text}`
    )
    .join("\n\n");
}

const KIND_ORDER: readonly DreamItemKind[] = [
  "summary",
  "chat-summary",
  "chat-title",
  "profile",
  "fact",
  "event",
];

function byKind(a: DreamWritten, b: DreamWritten): number {
  return KIND_ORDER.indexOf(a.itemKind) - KIND_ORDER.indexOf(b.itemKind);
}

/** A fact as it is shown: `Subject: sentence`. */
export function factWrittenText(subject: string, fact: string): string {
  return `${subject}: ${fact}`;
}

/** An event as it is shown: `date: sentence`, or the sentence alone with no date. */
export function eventWrittenText(occurredAt: string, event: string): string {
  return occurredAt.length > 0 ? `${occurredAt}: ${event}` : event;
}

function factText(row: DreamFactRow): string {
  return row.kind === "profile"
    ? row.fact
    : factWrittenText(row.subject, row.fact);
}

function eventText(row: DreamEventRow): string {
  return eventWrittenText(row.occurredAt, row.event);
}

const entryKey = (journalId: number): string => `entry:${journalId}`;
const chatKey = (chatId: number): string => `chat:${chatId}`;

/** The key of the source a fact or event row came from, or undefined for a row the user added. */
function sourceKey(type: string, id: number): string | undefined {
  if (type === "entry") {
    return entryKey(id);
  }
  return type === "conversation" ? chatKey(id) : undefined;
}

/** What Dream wrote for a chat itself: its summary and its title. */
function chatWritten(chat: DreamChatRow): DreamWritten[] {
  const items: DreamWritten[] = [];
  if (chat.summary !== null && chat.summary.trim().length > 0) {
    items.push({ itemKind: "chat-summary", text: chat.summary });
  }
  // Dream writes a title only when the chat was not renamed.
  if (!chat.titleLocked && chat.title.trim().length > 0) {
    items.push({ itemKind: "chat-title", text: chat.title });
  }
  return items;
}

/** Everything Dream wrote, by source key (`entry:<journal id>` or `chat:<id>`). */
function writtenBySource(rows: DreamRows): Map<string, DreamWritten[]> {
  const written = new Map<string, DreamWritten[]>();
  const add = (key: string | undefined, item: DreamWritten): void => {
    if (key !== undefined) {
      written.set(key, [...(written.get(key) ?? []), item]);
    }
  };
  for (const row of rows.entrySummaries) {
    add(entryKey(row.entryId), { itemKind: "summary", text: row.summary });
  }
  for (const chat of rows.chats) {
    for (const item of chatWritten(chat)) {
      add(chatKey(chat.id), item);
    }
  }
  for (const row of rows.facts) {
    add(sourceKey(row.sourceType, row.sourceId), {
      itemKind: row.kind === "profile" ? "profile" : "fact",
      text: factText(row),
    });
  }
  for (const row of rows.events) {
    add(sourceKey(row.sourceType, row.sourceId), {
      itemKind: "event",
      text: eventText(row),
    });
  }
  return written;
}

/**
 * Groups everything Dream wrote by its source. Entries come first, in the
 * order given, then chats by id. A source Dream wrote nothing from is left
 * out. Rows from a source that is not in the person's journal, and rows the
 * user added, are ignored. Rows are in id order, and the stable sort keeps
 * that order within a kind.
 */
export function groupDreamSources(
  rows: DreamRows,
  entries: readonly EntrySource[]
): DreamSource[] {
  const written = writtenBySource(rows);
  const sources: DreamSource[] = [];
  const push = (
    items: DreamWritten[] | undefined,
    source: Omit<DreamSource, "written">
  ): void => {
    if (items !== undefined && items.length > 0) {
      sources.push({ ...source, written: [...items].sort(byKind) });
    }
  };
  for (const entry of entries) {
    push(written.get(entryKey(entry.journalId)), {
      sourceId: entry.stem,
      sourceKind: "entry",
      sourceText: entrySourceText(entry),
    });
  }
  for (const chat of rows.chats) {
    push(written.get(chatKey(chat.id)), {
      sourceId: chatSourceId(chat.id),
      sourceKind: "chat",
      sourceText: chatText(chat),
    });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Grading one source
// ---------------------------------------------------------------------------

export type DreamGradeResult =
  | {
      callId?: string;
      cached: boolean;
      claims: UnsupportedClaim[];
      costUsd?: number;
      model: string;
      ok: true;
      rubric: string;
    }
  | { model: string; ok: false; reason: string; rubric: string };

/** Asks the judge about one source, or answers from the cache. Never throws. */
export async function gradeDreamSource(input: {
  cache: GradeCache;
  context: string;
  grader: Grader;
  itemId: string;
  source: DreamSource;
}): Promise<DreamGradeResult> {
  const { cache, context, grader, itemId, source } = input;
  const call = dreamSourceCall({
    context,
    label: `dream-accuracy ${itemId}`,
    source,
  });
  const inputHash = inputHashOf({ context, item: call.item });
  const hit = cache.get(itemId, inputHash);
  if (hit !== undefined) {
    return {
      cached: true,
      claims: hit.claims,
      model: grader.modelId,
      ok: true,
      rubric: grader.rubric,
    };
  }
  const outcome = await grader.judge(call);
  if (!outcome.ok) {
    return {
      model: grader.modelId,
      ok: false,
      reason: outcome.reason,
      rubric: grader.rubric,
    };
  }
  const claims = outcome.value.unsupportedClaims;
  cache.put({
    claims,
    gradedAt: new Date().toISOString(),
    inputHash,
    itemId,
    model: grader.modelId,
    rubric: grader.dreamRubric,
  });
  return {
    cached: false,
    callId: outcome.callId,
    claims,
    costUsd: outcome.costUsd,
    model: grader.modelId,
    ok: true,
    rubric: grader.rubric,
  };
}

/** Splits the claims by severity. */
export function splitClaims(claims: readonly UnsupportedClaim[]): {
  other: UnsupportedClaim[];
  severe: UnsupportedClaim[];
} {
  return {
    other: claims.filter((claim) => claim.severity === "other"),
    severe: claims.filter((claim) => claim.severity === "severe"),
  };
}

function describeClaims(
  claims: readonly UnsupportedClaim[]
): string | undefined {
  if (claims.length === 0) {
    return undefined;
  }
  return claims
    .map((claim) => `[${claim.itemKind}] "${claim.quote}": ${claim.reason}`)
    .join(" ");
}

/** What the report's Dream accuracy page needs for one source. */
export function dreamSourceReport(
  source: DreamSource,
  claims: readonly UnsupportedClaim[]
): DreamSourceReport {
  return {
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    sourceText: source.sourceText,
    unsupportedClaims: [...claims],
    written: source.written,
  };
}

const WHITESPACE_RUN = /\s+/gu;

/** Lowercase, with each run of whitespace as one space, so a quoted item matches the item it came from. */
function squash(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim().toLowerCase();
}

/**
 * Which item Dream wrote holds a claim, or null when none does. The judge is
 * told to copy the item's text, but it can give only part of it, or the quote
 * alone. So an item of the claim's kind is taken by the same text first, then
 * by holding the claim's item text, then by holding its quote. If no item of
 * that kind fits, the same three tries run over every item, in case the judge
 * named the wrong kind.
 */
function writtenIndexOf(
  written: readonly DreamWritten[],
  claim: UnsupportedClaim
): number | null {
  const itemText = squash(claim.itemText);
  const quote = squash(claim.quote);
  const matchers: ((text: string) => boolean)[] = [
    (text) => itemText.length > 0 && text === itemText,
    (text) => itemText.length > 0 && text.includes(itemText),
    (text) => quote.length > 0 && text.includes(quote),
  ];
  const squashed = written.map((item) => squash(item.text));
  const sameKind = written.flatMap((item, index) =>
    item.itemKind === claim.itemKind ? [index] : []
  );
  const everyItem = squashed.map((_, index) => index);
  for (const pool of [sameKind, everyItem]) {
    for (const matches of matchers) {
      const found = pool.find((index) => matches(squashed[index] ?? ""));
      if (found !== undefined) {
        return found;
      }
    }
  }
  return null;
}

/** One item that `dream-supported` grades, and the claims made against it. */
export interface DreamItemVerdict {
  claims: UnsupportedClaim[];
  itemKind: DreamItemKind;
  text: string;
}

/**
 * The `other` claims, each put against the item it is about. Every item Dream
 * wrote is one verdict, so three claims against one summary are one failure,
 * and a bad fact among ten items is one failure of ten. A claim that fits no
 * item Dream wrote (the judge quoted the source, say) still counts, as one
 * more verdict for each text it names.
 */
export function dreamItemVerdicts(
  source: DreamSource,
  claims: readonly UnsupportedClaim[]
): DreamItemVerdict[] {
  const verdicts: DreamItemVerdict[] = source.written.map((item) => ({
    claims: [],
    itemKind: item.itemKind,
    text: item.text,
  }));
  const strays = new Map<string, DreamItemVerdict>();
  for (const claim of claims) {
    const index = writtenIndexOf(source.written, claim);
    const found = index === null ? undefined : verdicts[index];
    if (found !== undefined) {
      found.claims.push(claim);
      continue;
    }
    const text = claim.itemText.length > 0 ? claim.itemText : claim.quote;
    const key = `${claim.itemKind}\u0000${squash(text)}`;
    const stray = strays.get(key) ?? {
      claims: [],
      itemKind: claim.itemKind,
      text,
    };
    stray.claims.push(claim);
    strays.set(key, stray);
  }
  return [...verdicts, ...strays.values()];
}

/**
 * Records the checks of a source, and a soft `dream-source` score that
 * carries the source and everything Dream wrote for the report.
 *
 * - `hard:no-severe-unsupported` is one check for the source. It fails when
 *   any claim is severe.
 * - `counted:dream-supported` is one check for each item Dream wrote from the
 *   source (see `dreamItemVerdicts`). An item fails when any `other` claim is
 *   about it, so the report divides failures by the items that were graded.
 * - A call the judge could not make records the hard check and one
 *   `dream-supported` as not graded.
 */
export function recordDreamGrade(
  t: ScoreHost,
  item: ItemRef,
  source: DreamSource,
  result: DreamGradeResult
): void {
  const common = {
    judgeModel: result.model,
    rubric: result.rubric,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };
  if (!result.ok) {
    for (const [checkId, tier] of [
      ["no-severe-unsupported", "hard"],
      ["dream-supported", "counted"],
    ] as const) {
      recordCheck(t, item, {
        checkId,
        extra: { ...common, claims: [] },
        notGraded: true,
        reason: result.reason,
        tier,
      });
    }
    recordCheck(t, item, {
      checkId: "dream-source",
      extra: { dream: dreamSourceReport(source, []), graded: false },
      notGraded: true,
      reason: result.reason,
      tier: "soft",
    });
    return;
  }
  const { other, severe } = splitClaims(result.claims);
  const judged = {
    ...common,
    cached: result.cached,
    ...(result.callId === undefined ? {} : { judgeCallId: result.callId }),
    ...(result.costUsd === undefined ? {} : { judgeCostUsd: result.costUsd }),
  };
  recordCheck(t, item, {
    checkId: "no-severe-unsupported",
    evidence: severe[0]?.quote,
    extra: { ...judged, claims: severe },
    pass: severe.length === 0,
    reason: describeClaims(severe),
    tier: "hard",
  });
  for (const verdict of dreamItemVerdicts(source, other)) {
    recordCheck(t, item, {
      checkId: "dream-supported",
      evidence: verdict.claims[0]?.quote,
      extra: {
        ...judged,
        claims: verdict.claims,
        itemKind: verdict.itemKind,
        itemText: verdict.text,
      },
      pass: verdict.claims.length === 0,
      reason: describeClaims(verdict.claims),
      tier: "counted",
    });
  }
  recordCheck(t, item, {
    checkId: "dream-source",
    extra: {
      ...judged,
      dream: dreamSourceReport(source, result.claims),
      graded: true,
    },
    pass: true,
    tier: "soft",
  });
}

// ---------------------------------------------------------------------------
// The evals
// ---------------------------------------------------------------------------

export interface DreamAccuracyDeps {
  /** The grade cache. Defaults to the one beside the snapshot (`SAGE_EVAL_DREAM_KEY`). */
  cache?: GradeCache;
  /** Path to `app.db`. Defaults to the throwaway Sage's (`SAGE_DATA_DIR`). */
  dbPath?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
  grader?: Grader;
  /** Chat ids for the evals made at import. Defaults to reading the database. */
  listChatIds?: () => number[];
  loadManifest?: () => Manifest;
  /** Reads what Dream wrote. Defaults to `readDreamRows`. */
  readRows?: (dbPath: string, options: { memory: boolean }) => DreamRows;
}

function defaultDbPath(): string {
  return join(evalDataDir(), "app.db");
}

function chatIdsAtImport(deps: DreamAccuracyDeps): number[] {
  try {
    return (
      deps.listChatIds ?? (() => listChatIds((deps.dbPath ?? defaultDbPath)()))
    )();
  } catch {
    return [];
  }
}

/**
 * One eval per source: each entry of the person's journal, and each chat in
 * the database. Entries are known from the files. Chats are not, so they are
 * found in the database at import, and a missing database means none. With
 * memory off, a skipped marker stands for the memory half.
 */
export function dreamAccuracyEvals(
  { pass, person }: PersonPass,
  deps: DreamAccuracyDeps = {}
): EvalDefinition[] {
  const env = deps.env ?? process.env;
  const memory = memoryOn(pass.setup);
  const tags = tagsFor(person, "dream-accuracy");
  const makeRef = (sourceId: string): ItemRef =>
    makeItem(
      {
        itemId: dreamItemId(person.id, sourceId),
        kind: "dream-source",
        person: person.id,
      },
      pass.setupId
    );

  let sources: Promise<DreamSource[]> | undefined;
  const loadSources = (): Promise<DreamSource[]> => {
    sources ??= Promise.resolve().then(() => {
      const manifest = (deps.loadManifest ?? loadManifest)();
      const entries = person.entries.map(
        (entry): EntrySource => ({
          body: entry.body,
          date: entry.date,
          journalId: journalIdFor(manifest, person.id, entry),
          stem: entry.stem,
          title: entry.title,
        })
      );
      const rows = (deps.readRows ?? readDreamRows)(
        (deps.dbPath ?? defaultDbPath)(),
        { memory }
      );
      return groupDreamSources(rows, entries);
    });
    return sources;
  };

  let grader: Grader | undefined;
  let cache: GradeCache | undefined;
  const context = formatFactSheet(person);

  const sourceEval = (
    sourceId: string,
    description: string
  ): EvalDefinition => {
    const item = makeRef(sourceId);
    return defineEval({
      description,
      metadata: itemMetadata(item),
      tags,
      async test(t) {
        const source = (await loadSources()).find(
          (candidate) => candidate.sourceId === sourceId
        );
        if (source === undefined) {
          t.skip(NOTHING_WRITTEN_REASON);
          return;
        }
        grader ??= deps.grader ?? sharedGrader();
        cache ??=
          deps.cache ??
          createGradeCache({
            key: env.SAGE_EVAL_DREAM_KEY,
            model: grader.modelId,
            rubric: grader.dreamRubric,
          });
        const result = await gradeDreamSource({
          cache,
          context,
          grader,
          itemId: item.itemId,
          source,
        });
        recordDreamGrade(t, item, source, result);
      },
    });
  };

  const evals = person.entries.map((entry) =>
    sourceEval(
      entry.stem,
      `${person.id}: Dream output from entry ${entry.index} (${entry.title})`
    )
  );
  for (const chatId of chatIdsAtImport(deps)) {
    evals.push(
      sourceEval(
        chatSourceId(chatId),
        `${person.id}: Dream output from chat ${chatId}`
      )
    );
  }
  if (!memory && evals.length > 0) {
    const marker = makeRef("memory");
    evals.push(
      defineEval({
        description: `${person.id}: Dream memory items (memory off)`,
        metadata: itemMetadata(marker),
        tags,
        test(t) {
          t.skip(MEMORY_OFF_REASON);
        },
      })
    );
  }
  return evals;
}
