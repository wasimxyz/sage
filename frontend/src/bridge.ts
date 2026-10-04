import type { JSONContent } from "@tiptap/react";
import type { ExportCounts } from "./lib/export-data-flow";
import { memoryEnabledFrom } from "./lib/memory-feature";
import type { NativeSdkInvokeError, NativeSdkJson } from "./zero";

// Command names and allowed origins are declared in app.json and again in src/main.zig.

export type BodyFormat = "plain" | "tiptap" | "markdown";

export interface BuildFeatures {
  memory: boolean;
}

export interface JournalEntryMeta {
  date: string;
  format: BodyFormat;
  id: number;
  title: string;
  updatedAt: string;
  wordCount: number;
}

export interface JournalEntry extends JournalEntryMeta {
  body: string;
}

export interface JournalSearchResult extends JournalEntryMeta {
  excerpt: string;
}

export type HomeFeedKind = "conversation" | "entry";

export interface HomeFeedItem {
  date: string;
  id: number;
  kind: HomeFeedKind;
  snippet: string;
  title: string;
}

export interface HomeLatestEntry {
  date: string;
  format: BodyFormat;
  id: number;
  snippet: string;
  title: string;
  updatedAt: string;
  wordCount: number;
}

export interface HomeFeed {
  items: HomeFeedItem[];
  latest: HomeLatestEntry | null;
}

export type ChatSearchRole = "assistant" | "user";

export interface ChatSearchHit {
  conversationId: number;
  excerpt: string;
  role: ChatSearchRole | null;
  seq: number | null;
  title: string;
  updatedAt: string;
}

export interface ImportFile {
  body: string;
  created: string;
  modified: string;
  name: string;
}

// Save chunks must fit the native payload decoder (128 KiB per call) after
// JSON escaping; 32 KiB keeps saves to a handful of round trips for long
// chat transcripts instead of hundreds.
const chunkBytes = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const whitespacePattern = /\s+/;

function nativeBridge() {
  const { zero } = window;
  if (!zero) {
    throw new Error("The native journal bridge is not available.");
  }
  return zero;
}

function asRecord(value: NativeSdkJson): { [key: string]: NativeSdkJson } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected bridge response.");
  }
  return value;
}

function asString(value: NativeSdkJson | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Unexpected bridge response.");
  }
  return value;
}

function asNumber(value: NativeSdkJson | undefined): number {
  if (typeof value !== "number") {
    throw new Error("Unexpected bridge response.");
  }
  return value;
}

function asBoolean(value: NativeSdkJson | undefined): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Unexpected bridge response.");
  }
  return value;
}

function asBooleanOrNull(value: NativeSdkJson | undefined): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asBoolean(value);
}

function asStringOrNull(value: NativeSdkJson | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asString(value);
}

function asNumberOrNull(value: NativeSdkJson | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asNumber(value);
}

function asChatSearchRole(
  value: NativeSdkJson | undefined
): ChatSearchRole | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value === "assistant" || value === "user") {
    return value;
  }
  throw new Error("Unexpected bridge response.");
}

function formatOf(value: NativeSdkJson | undefined): BodyFormat {
  if (value === "tiptap" || value === "markdown") {
    return value;
  }
  return "plain";
}

function invokeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as NativeSdkInvokeError).code);
    const message =
      error instanceof Error ? error.message : "Bridge command failed.";
    return `${code}: ${message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Bridge command failed.";
}

const missingRowCode = "NotFound";

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const { code } = error as { code: unknown };
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return null;
}

export function isMissingRowError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      break;
    }
    if (errorCode(current) === missingRowCode) {
      return true;
    }
    if (current instanceof Error) {
      if (
        current.message === missingRowCode ||
        current.message.startsWith(`${missingRowCode}:`) ||
        current.message.endsWith(`: ${missingRowCode}`)
      ) {
        return true;
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

async function invoke(
  command: string,
  payload: { [key: string]: NativeSdkJson } = {}
): Promise<NativeSdkJson> {
  try {
    return await nativeBridge().invoke(command, payload);
  } catch (error) {
    throw new Error(invokeErrorMessage(error), { cause: error });
  }
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function sliceUtf8Bytes(
  bytes: Uint8Array,
  byteOffset: number,
  maxBytes: number
): { byteLength: number; text: string } {
  if (byteOffset >= bytes.byteLength) {
    return { byteLength: 0, text: "" };
  }
  let end = Math.min(byteOffset + maxBytes, bytes.byteLength);
  if (end < bytes.byteLength) {
    // biome-ignore lint/suspicious/noBitwiseOperators: masks UTF-8 continuation bytes (0x80) to avoid splitting a multibyte sequence
    while (end > byteOffset && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
  }
  return {
    byteLength: end - byteOffset,
    text: decoder.decode(bytes.subarray(byteOffset, end)),
  };
}

function metaFrom(row: { [key: string]: NativeSdkJson }): JournalEntryMeta {
  return {
    date: asString(row.date),
    format: formatOf(row.format),
    id: asNumber(row.id),
    title: asString(row.title),
    updatedAt: asStringOrNull(row.updatedAt) ?? "",
    wordCount: asNumber(row.wordCount),
  };
}

export function hasNativeBridge(): boolean {
  return window.zero !== undefined;
}

export async function waitForNativeBridge(timeoutMs = 4000): Promise<boolean> {
  if (hasNativeBridge()) {
    return true;
  }
  const started = Date.now();
  return await new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (hasNativeBridge()) {
        window.clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

export function startWindowDrag(): void {
  const { zero } = window;
  if (!zero) {
    return;
  }
  zero.invoke("window.drag").catch(() => {
    // Window dragging is best-effort; failures are not actionable.
  });
}

export async function alignTitlebarButtons(
  heightPx: number,
  leadingPx?: number
): Promise<boolean> {
  const { zero } = window;
  if (!zero) {
    return false;
  }
  const payload: { [key: string]: NativeSdkJson } = { height: heightPx };
  if (leadingPx !== undefined) {
    payload.leading = leadingPx;
  }
  try {
    const result = await zero.invoke("window.alignTitlebar", payload);
    return (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.fullscreen === true
    );
  } catch {
    // Titlebar alignment is best-effort; failures are not actionable.
    return false;
  }
}

export async function listEntries(): Promise<JournalEntryMeta[]> {
  const response = asRecord(await invoke("journal.list", {}));
  const { entries } = response;
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected bridge response.");
  }
  return entries.map((item) => metaFrom(asRecord(item)));
}

export async function homeFeed(sinceDate: string): Promise<HomeFeed> {
  const response = asRecord(await invoke("home.feed", { sinceDate }));
  return {
    items: asJsonArray(response.items).map(homeItemFrom),
    latest: homeLatestFrom(response.latest),
  };
}

function homeLatestFrom(
  value: NativeSdkJson | undefined
): HomeLatestEntry | null {
  if (value === null || value === undefined) {
    return null;
  }
  const row = asRecord(value);
  return {
    ...metaFrom(row),
    snippet: asString(row.snippet),
  };
}

function homeItemFrom(item: NativeSdkJson): HomeFeedItem {
  const row = asRecord(item);
  const kind = asString(row.kind);
  if (kind !== "conversation" && kind !== "entry") {
    throw new Error("Unexpected bridge response.");
  }
  return {
    date: asString(row.date),
    id: asNumber(row.id),
    kind,
    snippet: asString(row.snippet),
    title: asString(row.title),
  };
}

export async function getBuildFeatures(): Promise<BuildFeatures> {
  const response = asRecord(await invoke("features.get", {}));
  return { memory: memoryEnabledFrom(response) };
}

export async function searchEntries(
  query: string
): Promise<JournalSearchResult[]> {
  const response = asRecord(await invoke("journal.search", { query }));
  const { entries } = response;
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected bridge response.");
  }
  return entries.map((item) => {
    const row = asRecord(item);
    return { ...metaFrom(row), excerpt: asString(row.excerpt) };
  });
}

export async function searchConversations(
  query: string
): Promise<ChatSearchHit[]> {
  const response = asRecord(await invoke("chat.search", { query }));
  const { hits } = response;
  if (!Array.isArray(hits)) {
    throw new Error("Unexpected bridge response.");
  }
  return hits.map((item) => {
    const row = asRecord(item);
    return {
      conversationId: asNumber(row.conversationId),
      excerpt: asString(row.excerpt),
      role: asChatSearchRole(row.role),
      seq: asNumberOrNull(row.seq),
      title: asString(row.title),
      updatedAt: asString(row.updatedAt),
    };
  });
}

export async function searchMemories(
  query: string
): Promise<MemorySearchHit[]> {
  const response = asRecord(await invoke("memory.search", { query }));
  const { hits } = response;
  if (!Array.isArray(hits)) {
    throw new Error("Unexpected bridge response.");
  }
  return hits.map((item) => memorySearchHitFrom(item));
}

export async function getEntry(id: number): Promise<JournalEntry> {
  let offset = 0;
  let body = "";
  let meta: JournalEntryMeta | null = null;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: chunked reads are sequential — each chunk's offset depends on the prior chunk's byte length
    const response = asRecord(await invoke("journal.get", { id, offset }));
    if (!meta) {
      meta = metaFrom(response);
    }
    const chunk = asString(response.chunk);
    body += chunk;
    if (asBoolean(response.done)) {
      break;
    }
    offset += utf8ByteLength(chunk);
  }
  return { ...meta, body };
}

export async function saveEntry(input: {
  id: number | null;
  title: string;
  date: string;
  wordCount: number;
  format: BodyFormat;
  body: string;
}): Promise<{ id: number; updatedAt: string }> {
  let offset = 0;
  let savedId = input.id;
  const bodyBytes = encoder.encode(input.body);
  const totalBytes = bodyBytes.byteLength;
  for (;;) {
    const chunk = sliceUtf8Bytes(bodyBytes, offset, chunkBytes);
    const done = offset + chunk.byteLength >= totalBytes;
    // biome-ignore lint/performance/noAwaitInLoops: chunked writes are sequential — each chunk's offset depends on the prior chunk's bytes written
    const result = await invoke("journal.save", {
      chunk: chunk.text,
      date: input.date,
      done,
      format: input.format,
      id: savedId,
      offset,
      title: input.title,
      wordCount: input.wordCount,
    });
    const response = asRecord(result);
    if (response.id !== null) {
      savedId = asNumber(response.id);
    }
    if (done) {
      if (savedId === null) {
        throw new Error("Save did not return an entry id.");
      }
      return {
        id: savedId,
        updatedAt: asStringOrNull(response.updatedAt) ?? "",
      };
    }
    offset += chunk.byteLength;
  }
}

export async function deleteEntry(id: number): Promise<void> {
  await invoke("journal.delete", { id });
}

export async function openMarkdownFileDialog(): Promise<string[]> {
  // The core retains this picker result and limits journal.readFile to it.
  const result = await invoke("journal.importDialog", {});
  if (result === null) {
    return [];
  }
  if (!Array.isArray(result)) {
    throw new Error("Unexpected bridge response.");
  }
  return result.map((item) => asString(item));
}

export async function openExportDirectoryDialog(): Promise<string | null> {
  // The native side runs the picker and remembers the folder. journal.export
  // accepts that folder and no other, so the picker decision cannot be
  // replaced by a path from this process.
  const response = asRecord(await invoke("journal.exportDialog", {}));
  return asStringOrNull(response.path);
}

export async function exportData(destDir: string): Promise<ExportCounts> {
  const response = asRecord(await invoke("journal.export", { destDir }));
  return {
    conversations: asNumber(response.conversations),
    entries: asNumber(response.entries),
  };
}

export interface DataCounts {
  conversations: number;
  embeddings: number;
  entries: number;
  memories: number;
}

export async function getDataCounts(): Promise<DataCounts> {
  const response = asRecord(await invoke("data.counts", {}));
  return {
    conversations: asNumber(response.conversations),
    embeddings: asNumber(response.embeddings),
    entries: asNumber(response.entries),
    memories: asNumber(response.memories),
  };
}

export async function deleteJournalEntries(): Promise<void> {
  await invoke("data.deleteEntries", {});
}

export async function deleteConversations(): Promise<void> {
  await invoke("data.deleteConversations", {});
}

export async function deleteEmbeddings(): Promise<void> {
  await invoke("data.deleteEmbeddings", {});
}

export async function deleteMemories(): Promise<void> {
  await invoke("data.deleteMemories", {});
}

export async function deleteAllData(): Promise<void> {
  await invoke("data.deleteAll", {});
}

export async function readImportFile(path: string): Promise<ImportFile> {
  let offset = 0;
  let body = "";
  let created = "";
  let modified = "";
  let name = "";
  for (;;) {
    const response = asRecord(
      // biome-ignore lint/performance/noAwaitInLoops: chunked reads are sequential — each chunk's offset depends on the prior chunk's byte length
      await invoke("journal.readFile", { offset, path })
    );
    if (name.length === 0) {
      created = asString(response.created);
      modified = asString(response.modified);
      name = asString(response.name);
    }
    const chunk = asString(response.chunk);
    body += chunk;
    if (asBoolean(response.done)) {
      break;
    }
    offset += utf8ByteLength(chunk);
  }
  return { body, created, modified, name };
}

export interface OllamaStatus {
  modelPulled: boolean;
  running: boolean;
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  const response = asRecord(await invoke("embeddings.status", {}));
  return {
    modelPulled: asBoolean(response.modelPulled),
    running: asBoolean(response.running),
  };
}

export interface EmbeddingResult {
  chunks: number;
  dimensions: number;
  model: string;
}

export async function generateEmbeddings(id: number): Promise<EmbeddingResult> {
  const response = asRecord(await invoke("embeddings.generate", { id }));
  return {
    chunks: asNumber(response.chunks),
    dimensions: asNumber(response.dimensions),
    model: asString(response.model),
  };
}

export async function listPendingEmbeddings(): Promise<number[]> {
  const response = asRecord(await invoke("embeddings.pending", {}));
  const { ids } = response;
  if (!Array.isArray(ids)) {
    throw new Error("Unexpected bridge response.");
  }
  return ids.map((item) => asNumber(item));
}

export interface DreamStatus {
  done: number;
  lastDreamedAt: string | null;
  running: boolean;
  total: number;
}

export interface DreamStartResult {
  ok: boolean;
  total: number;
}

export async function startDream(): Promise<DreamStartResult> {
  const response = asRecord(await invoke("dream.start", {}));
  return {
    ok: asBoolean(response.ok),
    total: asNumber(response.total),
  };
}

export async function getDreamStatus(): Promise<DreamStatus> {
  const response = asRecord(await invoke("dream.status", {}));
  return {
    done: asNumber(response.done),
    lastDreamedAt: asStringOrNull(response.lastDreamedAt),
    running: asBoolean(response.running),
    total: asNumber(response.total),
  };
}

export function onDreamStarted(
  callback: (payload: { total: number }) => void
): () => void {
  return onWindowEvent("dream:started", (detail) => {
    try {
      const record = asRecord(detail);
      callback({ total: asNumber(record.total) });
    } catch {
      // Ignore a malformed window event.
    }
  });
}

export function onDreamProgress(
  callback: (payload: { done: number; total: number }) => void
): () => void {
  return onWindowEvent("dream:progress", (detail) => {
    try {
      const record = asRecord(detail);
      callback({
        done: asNumber(record.done),
        total: asNumber(record.total),
      });
    } catch {
      // Ignore a malformed window event.
    }
  });
}

export function onDreamFinished(
  callback: (payload: {
    events: number;
    facts: number;
    failures: number;
  }) => void
): () => void {
  return onWindowEvent("dream:finished", (detail) => {
    try {
      const record = asRecord(detail);
      callback({
        events: asNumber(record.events),
        facts: asNumber(record.facts),
        failures: asNumber(record.failures),
      });
    } catch {
      // Ignore a malformed window event.
    }
  });
}

export type MemoryKind = "event" | "fact" | "profile";

export interface MemorySearchHit {
  event: string;
  excerpt: string;
  fact: string;
  id: number;
  kind: MemoryKind;
  occurredAt: string;
  sourceTitle: string;
  subject: string;
  updatedAt: string;
}

export interface ProfileMemory {
  fact: string;
  id: number;
  pinned: boolean;
  sourceId: number;
  sourceType: string;
  updatedAt: string;
}

export interface FactMemory {
  fact: string;
  id: number;
  pinned: boolean;
  sourceId: number;
  sourceType: string;
  subject: string;
  updatedAt: string;
}

export interface EventMemory {
  event: string;
  id: number;
  occurredAt: string;
  pinned: boolean;
  sourceId: number;
  sourceTitle: string;
  sourceType: string;
  updatedAt: string;
}

export interface MemoryList {
  events: EventMemory[];
  facts: FactMemory[];
  profile: ProfileMemory[];
}

export type SaveMemoryInput =
  | { fact: string; id?: number; kind: "profile" }
  | { fact: string; id?: number; kind: "fact"; subject: string }
  | { event: string; id?: number; kind: "event"; occurredAt?: string };

export async function listMemories(): Promise<MemoryList> {
  const response = asRecord(await invoke("memory.list", {}));
  return {
    events: asJsonArray(response.events).map(eventMemoryFrom),
    facts: asJsonArray(response.facts).map(factMemoryFrom),
    profile: asJsonArray(response.profile).map(profileMemoryFrom),
  };
}

export async function saveMemory(input: SaveMemoryInput): Promise<number> {
  const payload: { [key: string]: NativeSdkJson } = { kind: input.kind };
  if (input.id !== undefined) {
    payload.id = input.id;
  }
  if (input.kind === "profile") {
    payload.fact = input.fact;
  } else if (input.kind === "fact") {
    payload.fact = input.fact;
    payload.subject = input.subject;
  } else {
    payload.event = input.event;
    payload.occurredAt = input.occurredAt ?? "";
  }
  const response = asRecord(await invoke("memory.save", payload));
  return asNumber(response.id);
}

export async function deleteMemory(
  kind: MemoryKind,
  id: number
): Promise<void> {
  await invoke("memory.delete", { id, kind });
}

function asJsonArray(value: NativeSdkJson | undefined): NativeSdkJson[] {
  if (!Array.isArray(value)) {
    throw new Error("Unexpected bridge response.");
  }
  return value;
}

function memorySourceFrom(row: { [key: string]: NativeSdkJson }): {
  id: number;
  pinned: boolean;
  sourceId: number;
  sourceType: string;
  updatedAt: string;
} {
  return {
    id: asNumber(row.id),
    pinned: asBoolean(row.pinned),
    sourceId: asNumber(row.sourceId),
    sourceType: asString(row.sourceType),
    updatedAt: asString(row.updatedAt),
  };
}

function profileMemoryFrom(item: NativeSdkJson): ProfileMemory {
  const row = asRecord(item);
  return {
    ...memorySourceFrom(row),
    fact: asString(row.fact),
  };
}

function factMemoryFrom(item: NativeSdkJson): FactMemory {
  const row = asRecord(item);
  return {
    ...memorySourceFrom(row),
    fact: asString(row.fact),
    subject: asString(row.subject),
  };
}

function eventMemoryFrom(item: NativeSdkJson): EventMemory {
  const row = asRecord(item);
  return {
    ...memorySourceFrom(row),
    event: asString(row.event),
    occurredAt: asString(row.occurredAt),
    sourceTitle: asString(row.sourceTitle),
  };
}

function memorySearchHitFrom(item: NativeSdkJson): MemorySearchHit {
  const row = asRecord(item);
  return {
    event: asString(row.event),
    excerpt: asString(row.excerpt),
    fact: asString(row.fact),
    id: asNumber(row.id),
    kind: asMemoryKind(row.kind),
    occurredAt: asString(row.occurredAt),
    sourceTitle: asString(row.sourceTitle),
    subject: asString(row.subject),
    updatedAt: asString(row.updatedAt),
  };
}

function asMemoryKind(value: NativeSdkJson | undefined): MemoryKind {
  if (value === "event" || value === "fact" || value === "profile") {
    return value;
  }
  throw new Error("Unexpected bridge response.");
}

export function onDreamFailed(
  callback: (payload: { message: string }) => void
): () => void {
  return onWindowEvent("dream:failed", (detail) => {
    try {
      const record = asRecord(detail);
      callback({ message: asString(record.message) });
    } catch {
      // Ignore a malformed window event.
    }
  });
}

// --- app lock ---

/** Whether FileVault encrypts this Mac's disk; "unknown" when it cannot be read. */
export type FileVaultState = "off" | "on" | "unknown";

export interface LockStatus {
  enabled: boolean;
  encrypted: boolean;
  fileVault: FileVaultState;
  idleTimeoutMs: number;
  passwordSet: boolean;
  /** This session was unlocked with the recovery key, so no current password is asked for. */
  recoveredSession: boolean;
  /** The recovery key was just used, so Sage owes a new one. */
  recoveryKeyRotate: boolean;
  /** A recovery key can unlock the journal when Touch ID cannot. */
  recoveryKeySet: boolean;
  scrubbing: boolean;
  securing: boolean;
  touchIdAvailable: boolean;
  touchIdBiometrics: boolean;
  touchIdEnabled: boolean;
  unlocked: boolean;
  /** Milliseconds left before Zig accepts another guess; 0 when there is no wait. */
  waitRemainingMs: number;
}

function asFileVaultState(value: unknown): FileVaultState {
  return value === "on" || value === "off" ? value : "unknown";
}

export async function getLockStatus(): Promise<LockStatus> {
  const response = asRecord(await invoke("lock.status", {}));
  return {
    enabled: asBoolean(response.enabled),
    encrypted: asBoolean(response.encrypted),
    fileVault: asFileVaultState(response.fileVault),
    idleTimeoutMs: asNumber(response.idleTimeoutMs),
    passwordSet: asBoolean(response.passwordSet),
    recoveredSession: asBoolean(response.recoveredSession),
    recoveryKeyRotate: asBoolean(response.recoveryKeyRotate),
    recoveryKeySet: asBoolean(response.recoveryKeySet),
    scrubbing: asBoolean(response.scrubbing),
    securing: asBoolean(response.securing),
    touchIdAvailable: asBoolean(response.touchIdAvailable),
    touchIdBiometrics: asBoolean(response.touchIdBiometrics),
    touchIdEnabled: asBoolean(response.touchIdEnabled),
    unlocked: asBoolean(response.unlocked),
    waitRemainingMs: asNumber(response.waitRemainingMs),
  };
}

export async function setLockIdleTimeout(idleTimeoutMs: number): Promise<void> {
  await invoke("lock.setIdleTimeout", { idleTimeoutMs });
}

export async function unlockWithPassword(password: string): Promise<void> {
  await invoke("lock.unlock", { password });
}

export async function unlockWithTouchId(): Promise<void> {
  await invoke("lock.unlockTouchId", {});
}

/// For a journal whose Keychain copy is lost, or whose owner forgot the
/// password. Shares the password's wrong-guess wait. `touchIdKeyMissing` is
/// true when the journal is open but Sage could not store the copy that Touch
/// ID needs.
export async function unlockWithRecoveryKey(
  recoveryKey: string
): Promise<{ touchIdKeyMissing: boolean }> {
  const response = asRecord(
    await invoke("lock.unlockRecoveryKey", { recoveryKey })
  );
  return { touchIdKeyMissing: asBoolean(response.touchIdKeyMissing) };
}

export async function setLockPassword(input: {
  current: string | null;
  next: string;
}): Promise<void> {
  await invoke("lock.setPassword", {
    current: input.current,
    next: input.next,
  });
}

export async function disableLock(password: string | null): Promise<void> {
  await invoke("lock.disable", { password });
}

/// Remove the password and keep Touch ID as the way in. The password is the
/// proof, except after an unlock with the recovery key. An encrypted journal
/// with no recovery key yet needs a new one that came from `requestRecoveryKey`.
export async function removeLockPassword(input: {
  password: string | null;
  recoveryKey: string | null;
}): Promise<void> {
  await invoke("lock.removePassword", {
    password: input.password,
    recoveryKey: input.recoveryKey,
  });
}

/// Turn Touch ID on, or turn it off. Turning it off needs a current password
/// when one is set; without one the native side shows a system prompt and the
/// promise settles when the sheet does.
export async function setTouchIdEnabled(
  enabled: boolean,
  password: string | null = null
): Promise<void> {
  await invoke("lock.setTouchId", { enabled, password });
}

/// With a password set, the password proves who is asking. With Touch ID as
/// the only method there is none, so the journal is wrapped by the recovery
/// key that `requestRecoveryKey` returned and the person typed back.
export type EnableEncryptionInput =
  | { password: string }
  | { recoveryKey: string };

export async function enableEncryption(
  input: EnableEncryptionInput
): Promise<void> {
  await invoke("encryption.enable", input);
}

/// With no password set, the promise settles when the system sheet does.
export async function disableEncryption(
  password: string | null
): Promise<void> {
  await invoke("encryption.disable", { password });
}

/// Ask Sage for a new recovery key. The password proves who is asking; with
/// no password the promise settles when the system sheet does. Sage keeps the
/// key until it comes back through `enableEncryption`, `removeLockPassword`,
/// or `saveRecoveryKey`, so the page can show a key but never choose one.
export async function requestRecoveryKey(
  password: string | null
): Promise<string> {
  const response = asRecord(
    await invoke("encryption.newRecoveryKey", { password })
  );
  return asString(response.recoveryKey);
}

/// Replace the recovery key with the one `requestRecoveryKey` returned.
export async function saveRecoveryKey(recoveryKey: string): Promise<void> {
  await invoke("encryption.saveRecoveryKey", { recoveryKey });
}

export async function runEncryptionScrub(): Promise<void> {
  await invoke("encryption.scrub", {});
}

export async function listOllamaModels(): Promise<string[]> {
  const response = asRecord(await invoke("ollama.models", {}));
  const { models } = response;
  if (!Array.isArray(models)) {
    throw new Error("Unexpected bridge response.");
  }
  return models.map((item) => asString(item));
}

// Ollama is down: the core launches it and answers once `/api/tags` replies,
// so a resolved call means the server is up.
export async function startOllamaServer(): Promise<void> {
  await invoke("ollama.start", {});
}

export interface SystemHardware {
  chipName: string;
  cpuCores: number;
  ramGb: number;
}

export async function getSystemHardware(): Promise<SystemHardware> {
  const response = asRecord(await invoke("system.hardware", {}));
  return {
    chipName: asString(response.chipName),
    cpuCores: asNumber(response.cpuCores),
    ramGb: asNumber(response.ramGb),
  };
}

export interface OllamaPullProgress {
  active: boolean;
  cancelled: boolean;
  completed: number;
  done: boolean;
  failed: boolean;
  model: string;
  status: string;
  total: number;
}

export async function pullOllamaModel(name: string): Promise<void> {
  await invoke("ollama.pull", { name });
}

export async function getOllamaPull(): Promise<OllamaPullProgress | null> {
  const response = asRecord(await invoke("ollama.pulls", {}));
  if (response.pull === null) {
    return null;
  }
  const pull = asRecord(response.pull);
  return {
    active: asBoolean(pull.active),
    cancelled: asBoolean(pull.cancelled),
    completed: asNumber(pull.completed),
    done: asBoolean(pull.done),
    failed: asBoolean(pull.failed),
    model: asString(pull.model),
    status: asString(pull.status),
    total: asNumber(pull.total),
  };
}

export async function cancelOllamaPull(): Promise<void> {
  await invoke("ollama.pullCancel", {});
}

export async function deleteOllamaModel(name: string): Promise<void> {
  await invoke("ollama.delete", { name });
}

export interface ChatConversationMeta {
  id: number;
  title: string;
  updatedAt: string;
}

export interface ChatConversation extends ChatConversationMeta {
  contextLength: number | null;
  createdAt: string;
  events: unknown[];
  eveSessionId: string | null;
  model: string;
  streamIndex: number;
  thinking: boolean | null;
}

export async function chatList(): Promise<ChatConversationMeta[]> {
  const response = asRecord(await invoke("chat.list", {}));
  const { conversations } = response;
  if (!Array.isArray(conversations)) {
    throw new Error("Unexpected bridge response.");
  }
  return conversations.map((item) => {
    const row = asRecord(item);
    return {
      id: asNumber(row.id),
      title: asString(row.title),
      updatedAt: asString(row.updatedAt),
    };
  });
}

export async function chatGet(id: number): Promise<ChatConversation> {
  let offset = 0;
  const events: unknown[] = [];
  let meta: Omit<ChatConversation, "events"> | null = null;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: paged reads are sequential — each page's offset is the prior page's nextSeq
    const response = asRecord(await invoke("chat.get", { id, offset }));
    if (!meta) {
      meta = {
        contextLength: asNumberOrNull(response.contextLength),
        createdAt: asString(response.createdAt),
        eveSessionId:
          response.eveSessionId === null
            ? null
            : asString(response.eveSessionId),
        id: asNumber(response.id),
        model: asString(response.model),
        streamIndex: asNumber(response.streamIndex),
        thinking: asBooleanOrNull(response.thinking),
        title: asString(response.title),
        updatedAt: asString(response.updatedAt),
      };
    }
    if (!Array.isArray(response.events)) {
      throw new Error("Unexpected bridge response.");
    }
    events.push(...response.events);
    if (asBoolean(response.done)) {
      break;
    }
    offset = asNumber(response.nextSeq);
  }
  return { ...meta, events };
}

export async function chatSave(input: {
  baseSeq: number;
  contextLength: number;
  eveSessionId: string | null;
  events: string;
  id: number | null;
  model: string;
  streamIndex: number;
  thinking: boolean;
  title: string;
}): Promise<number> {
  let offset = 0;
  let savedId = input.id;
  const eventBytes = encoder.encode(input.events);
  const totalBytes = eventBytes.byteLength;
  for (;;) {
    const chunk = sliceUtf8Bytes(eventBytes, offset, chunkBytes);
    const done = offset + chunk.byteLength >= totalBytes;
    let result: NativeSdkJson;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: chunked writes are sequential — each chunk's offset depends on the prior chunk's bytes written
      result = await invoke("chat.save", {
        baseSeq: input.baseSeq,
        chunk: chunk.text,
        contextLength: input.contextLength,
        done,
        eveSessionId: input.eveSessionId,
        id: savedId,
        model: input.model,
        offset,
        streamIndex: input.streamIndex,
        thinking: input.thinking,
        title: input.title,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("ChatEventTooLarge")
      ) {
        throw new Error(
          "A single chat event is too large to save (over 128 KB).",
          { cause: error }
        );
      }
      throw error;
    }
    const response = asRecord(result);
    if (response.id !== null) {
      savedId = asNumber(response.id);
    }
    if (done) {
      if (savedId === null) {
        throw new Error("Save did not return a conversation id.");
      }
      return savedId;
    }
    offset += chunk.byteLength;
  }
}

export async function chatSavePrefs(input: {
  contextLength: number;
  id: number;
  model: string;
  thinking: boolean;
}): Promise<void> {
  await invoke("chat.savePrefs", {
    contextLength: input.contextLength,
    id: input.id,
    model: input.model,
    thinking: input.thinking,
  });
}

export async function chatRename(input: {
  id: number;
  title: string;
}): Promise<void> {
  await invoke("chat.rename", {
    id: input.id,
    title: input.title,
  });
}

export async function chatDelete(id: number): Promise<void> {
  await invoke("chat.delete", { id });
}

export type ChatAgentStatusKind =
  | "down"
  | "missing_build"
  | "missing_node"
  | "port_busy"
  | "ready";

export interface ChatAgentStatus {
  host: string | null;
  message: string;
  status: ChatAgentStatusKind;
}

export async function getChatAgent(): Promise<ChatAgentStatus> {
  const response = asRecord(await invoke("chat.agent", {}));
  return {
    host: typeof response.host === "string" ? response.host : null,
    message: asString(response.message),
    status: asChatAgentStatusKind(response.status),
  };
}

export async function getChatAgentToken(): Promise<string | null> {
  const { token } = asRecord(await invoke("chat.agentToken", {}));
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return token;
}

export interface AgentInstructions {
  builtin: string;
  user: string;
}

export async function getAgentInstructions(): Promise<AgentInstructions> {
  const response = asRecord(await invoke("agent.instructions.get", {}));
  return {
    builtin: asString(response.builtin),
    user: asString(response.user),
  };
}

export async function saveAgentInstructions(user: string): Promise<void> {
  await invoke("agent.instructions.save", { user });
}

function asChatAgentStatusKind(
  value: NativeSdkJson | undefined
): ChatAgentStatusKind {
  if (
    value === "down" ||
    value === "missing_build" ||
    value === "missing_node" ||
    value === "port_busy" ||
    value === "ready"
  ) {
    return value;
  }
  return "down";
}

/** Subscribe to the Sage > Settings menu item. Returns an unsubscribe. */
export function onOpenSettings(callback: () => void): () => void {
  return onWindowEvent("settings:open", () => {
    callback();
  });
}

/** Subscribe to native session-lock changes. Returns an unsubscribe. */
export function onLockChanged(callback: () => void): () => void {
  return onWindowEvent("lock:changed", () => {
    callback();
  });
}

/** Subscribe to a Lock action when the app lock is off. */
export function onLockUnavailable(callback: () => void): () => void {
  return onWindowEvent("lock:unavailable", () => {
    callback();
  });
}

/** Subscribe to File > Import. Returns an unsubscribe. */
export function onJournalImport(callback: () => void): () => void {
  return onWindowEvent("journal:import", () => {
    callback();
  });
}

/** Subscribe to File > Export. Returns an unsubscribe. */
export function onJournalExport(callback: () => void): () => void {
  return onWindowEvent("journal:export", () => {
    callback();
  });
}

function onWindowEvent(
  name: string,
  callback: (detail: NativeSdkJson) => void
): () => void {
  const { zero } = window;
  if (!zero?.on) {
    return () => undefined;
  }
  return zero.on(name, callback);
}

export function plainTextToTiptap(text: string): JSONContent {
  const lines = text.length === 0 ? [""] : text.split("\n");
  return {
    content: lines.map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { content: [{ text: line, type: "text" }], type: "paragraph" }
    ),
    type: "doc",
  };
}

export function parseStoredDoc(entry: JournalEntry): JSONContent {
  if (entry.format === "tiptap") {
    try {
      const parsed: unknown = JSON.parse(entry.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JSONContent;
      }
    } catch {
      // Existing rows may still be plain text even if the format flag is wrong.
    }
  }
  return plainTextToTiptap(entry.body);
}

export function todayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function countWords(text: string): number {
  const parts = text.trim().split(whitespacePattern);
  if (parts.length === 1 && parts[0] === "") {
    return 0;
  }
  return parts.length;
}
