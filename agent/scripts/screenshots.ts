import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMatchingId, requireOk } from "../evals/lib/bridge.ts";
import {
  type JournalEntryFixture,
  loadEntryFiles,
} from "../evals/lib/dataset.ts";
import {
  type Automation,
  automationAt,
  BridgeTimeoutError,
  callBridge,
  waitForAutomation,
} from "./automation.ts";
import { chatSourceFiles, screenshotChat } from "./screenshot-chat.ts";
import { localToday, moveToToday } from "./seed-dates.ts";

// Drives a throwaway packaged Sage that scripts/screenshots.sh built with
// automation on and started on a scratch journal. It fills the journal,
// opens each screen with `app.route:<route>`, switches light and dark with
// `app.appearance:<name>`, and captures the window with screencapture.

export const appearances = ["light", "dark"] as const;
export type Appearance = (typeof appearances)[number];

/** The window size in points. On a Retina display the PNGs are twice this. */
export const windowSize = { height: 800, width: 1280 } as const;

/**
 * The saved window frame the app opens at. scripts/screenshots.sh writes it
 * into the scratch journal's State folder before Sage starts, since
 * `native automate resize` resizes a canvas, not the window.
 */
export function windowStateZon(): string {
  return [
    ".{",
    "  .windows = .{",
    `    .{ .id = 1, .label = "main", .title = "Sage", .open = true, .focused = true, .x = 40, .y = 40, .width = ${windowSize.width}, .height = ${windowSize.height}, .scale = 2, .maximized = false, .fullscreen = false },`,
    "  },",
    "}",
    "",
  ].join("\n");
}

/** Setup steps, in the order setup shows them. */
export const setupShots = [
  { name: "setup-welcome", step: "welcome" },
  { name: "setup-local-ai", step: "local_ai" },
  { name: "setup-protect", step: "protect" },
  { name: "setup-import", step: "import" },
  { name: "setup-all-set", step: "all_set" },
] as const;

/** The seed entry the Journal shot opens. */
export const journalShotFile = "25-sunday-again.md";

export interface ShotIds {
  chat: number;
  journalEntry: number;
}

/** Screens of the unlocked app, each a hash route. */
export function appShots(ids: ShotIds): { name: string; route: string }[] {
  return [
    { name: "new-chat", route: "/chat/new" },
    { name: "journal", route: `/journal/${ids.journalEntry}` },
    { name: "chat", route: `/chat/${ids.chat}` },
    { name: "settings-agent", route: "/settings" },
    { name: "settings-models", route: "/settings/models" },
    { name: "settings-data", route: "/settings/data" },
  ];
}

/** Taken after the password and Touch ID are on. */
export const securityShot = {
  name: "settings-security",
  route: "/settings/security",
};
/** Taken last, after `app.lock` from a new chat. */
export const lockShotName = "lock";
export const lockRoute = "/chat/new";

/** Hash routes the shots open: lowercase parts after single slashes. */
export const routePattern = /^(\/[a-z0-9-]+)+$/u;

/**
 * The `app.route:` command for a hash route. The automation server refuses a
 * command name with a slash in it, so `/chat/3` goes as `chat.3`, and
 * `isAutomationRoute` in src/main.zig turns the dots back into slashes.
 */
export function routeCommand(route: string): string {
  if (!routePattern.test(route) || route.length > 64) {
    throw new Error(`Not a route app.route accepts: ${route}`);
  }
  return `app.route:${route.slice(1).replaceAll("/", ".")}`;
}

/**
 * The only bridge commands this script sends. The journal is a throwaway, and
 * its Touch ID key has a Keychain service of its own. Still, nothing here
 * turns Touch ID or the lock off, deletes data, or downloads a model, so a
 * mistake can't reach the Keychain item or the models your own Sage uses.
 */
export const allowedBridgeCommands = [
  "chat.list",
  "chat.save",
  "embeddings.pending",
  "embeddings.status",
  "journal.list",
  "journal.save",
  "lock.setPassword",
  "lock.setTouchId",
  "lock.status",
  "ollama.models",
  "ollama.setupStatus",
  "onboarding.remindersOff",
  "onboarding.save",
] as const;

export function checkBridgeCall(
  command: string,
  payload: Record<string, unknown>
): void {
  if (!(allowedBridgeCommands as readonly string[]).includes(command)) {
    throw new Error(`make screenshots does not send ${command}.`);
  }
  if (command === "lock.setTouchId" && payload.enabled !== true) {
    throw new Error("make screenshots only turns Touch ID on.");
  }
}

interface Context {
  automation: Automation;
  helper: string;
  out: string;
  pid: number;
  windowId: number;
}

const settleMs = 1500;
const appearanceSettleMs = 700;
const focusWaitMs = 120_000;
const embedWaitMs = 90_000;
const localAiWaitMs = 60_000;

async function main(): Promise<void> {
  const automation = automationAt(requiredEnv("SAGE_AUTOMATION_CWD"));
  const seedDir = requiredEnv("SAGE_SEED_DIR");
  const out = requiredEnv("SAGE_SCREENSHOTS_OUT");
  const helper = requiredEnv("SAGE_SCREENSHOTS_HELPER");
  const pid = Number(requiredEnv("SAGE_PID"));
  mkdirSync(out, { recursive: true });

  const { entries } = moveToToday(await loadEntryFiles(seedDir), localToday());

  waitForAutomation(automation);
  const ctx: Context = {
    automation,
    helper,
    out,
    pid,
    windowId: windowIdFor(helper, pid),
  };
  console.log(`Sage window ${ctx.windowId}`);
  checkModels(ctx);

  // A new journal opens on Welcome. Each later step is a saved setup state
  // and a reload, the way a half-finished setup opens on the next launch.
  for (const shot of setupShots) {
    if (shot.step !== "welcome") {
      bridge(ctx, "onboarding.save", { state: "active", step: shot.step });
      automate(automation, ["reload"]);
      sleep(settleMs);
    }
    capture(ctx, shot.name);
  }

  bridge(ctx, "onboarding.save", { state: "done" });
  bridge(ctx, "onboarding.remindersOff", {});
  const ids = new Map<string, number>();
  for (const entry of entries) {
    ids.set(entry.fileName, saveEntry(ctx, entry));
  }
  console.log(`Saved ${entries.length} entries.`);
  const chatId = saveChat(ctx, entries, ids);
  automate(automation, ["reload"]);
  waitForEmbeddings(ctx);

  for (const shot of appShots({
    chat: chatId,
    journalEntry: idFor(ids, journalShotFile),
  })) {
    openRoute(ctx, shot.route);
    capture(ctx, shot.name);
  }

  setPassword(ctx, randomBytes(18).toString("base64url"));
  // A Mac with no Touch ID refuses, so a failure here only warns.
  const touchId = sendBridge(ctx, "lock.setTouchId", { enabled: true });
  if (touchId.ok === false) {
    console.warn(
      "Touch ID could not turn on, so the lock screen has no Touch ID button."
    );
  }
  openRoute(ctx, securityShot.route);
  capture(ctx, securityShot.name);

  openRoute(ctx, lockRoute);
  sendNativeCommand(ctx, "app.lock");
  sleep(settleMs);
  // The same route again only clears focus, so the password field shows no caret.
  sendNativeCommand(ctx, routeCommand(lockRoute));
  capture(ctx, lockShotName);

  console.log(`Saved the screenshots in ${out}.`);
}

/**
 * The Local AI step downloads any model Sage needs that this Mac lacks, the
 * moment it opens. That download goes into the ~/.ollama your own Sage uses,
 * and its progress would show in the shots. So the run stops first, with the
 * same check the step makes.
 */
function checkModels(ctx: Context): void {
  const deadline = Date.now() + localAiWaitMs;
  let setup = bridge(ctx, "ollama.setupStatus", {});
  while (resultField(setup, "running") !== true) {
    if (resultField(setup, "installed") === false) {
      throw new Error("The copy has no Ollama. Run make screenshots again.");
    }
    if (Date.now() > deadline) {
      throw new Error("Local AI did not start in the copy.");
    }
    sleep(1000);
    setup = bridge(ctx, "ollama.setupStatus", {});
  }
  const missing: string[] = [];
  const embedModel = resultField(setup, "embedModel");
  const summaryModel = resultField(setup, "summaryModel");
  if (
    resultField(bridge(ctx, "embeddings.status", {}), "modelPulled") !== true
  ) {
    missing.push(
      typeof embedModel === "string" ? embedModel : "nomic-embed-text"
    );
  }
  const installed = resultField(bridge(ctx, "ollama.models", {}), "models");
  if (
    typeof summaryModel !== "string" ||
    !Array.isArray(installed) ||
    !hasModel(
      installed.filter((name): name is string => typeof name === "string"),
      summaryModel
    )
  ) {
    missing.push(
      typeof summaryModel === "string" ? summaryModel : "qwen3.5:9b"
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `This Mac does not have ${missing.join(" or ")}. Download it in Sage under Settings › Models, quit Sage, then run make screenshots again.`
    );
  }
}

/**
 * The rule the Local AI step uses (`modelNameMatches` in
 * frontend/src/lib/models.ts): an installed name matches the tag itself, or
 * the tag followed by `:` or `-`, with any `:latest` left off.
 */
export function hasModel(installed: readonly string[], tag: string): boolean {
  const want = withoutLatest(tag);
  return installed.some((name) => {
    const have = withoutLatest(name);
    return (
      have === want ||
      have.startsWith(`${want}:`) ||
      have.startsWith(`${want}-`)
    );
  });
}

function withoutLatest(name: string): string {
  return name.endsWith(":latest") ? name.slice(0, -":latest".length) : name;
}

function saveChat(
  ctx: Context,
  entries: readonly { date: string; fileName: string; title: string }[],
  ids: Map<string, number>
): number {
  const sources = chatSourceFiles.map((fileName) => {
    const entry = entries.find((item) => item.fileName === fileName);
    if (entry === undefined) {
      throw new Error(`The chat cites ${fileName}, which is not in the seed.`);
    }
    return { date: entry.date, id: idFor(ids, fileName), title: entry.title };
  });
  const chat = screenshotChat(sources, new Date());
  const id = saveInOneCall(
    ctx,
    "chat.save",
    {
      baseSeq: 0,
      chunk: oneChunk(JSON.stringify(chat.events), "The chat"),
      contextLength: chat.contextLength,
      done: true,
      eveSessionId: null,
      id: null,
      model: chat.model,
      offset: 0,
      streamIndex: chat.events.length,
      thinking: chat.thinking,
      title: chat.title,
    },
    () => savedChatId(ctx, chat.title)
  );
  console.log(`Saved the chat as ${id}.`);
  return id;
}

function saveEntry(ctx: Context, entry: JournalEntryFixture): number {
  return saveInOneCall(
    ctx,
    "journal.save",
    {
      chunk: oneChunk(entry.body, entry.fileName),
      date: entry.date,
      done: true,
      format: "markdown",
      id: null,
      offset: 0,
      title: entry.title,
      wordCount: entry.wordCount,
    },
    () => savedEntryId(ctx, entry)
  );
}

/**
 * The most one save carries. The Native SDK takes an automation command of up
 * to 16 KiB, and the chunk goes inside it as an escaped JSON string, so this
 * leaves room for the escapes and the rest of the command. The screenshot
 * chat, in eve 1.0's event format, is about 5 KB.
 */
export const maxChunkBytes = 8000;

/**
 * The text of a save that fits in one call. A save split over several calls
 * leaves a half-finished upload when an answer is lost, so the script only
 * saves what fits in one.
 */
export function oneChunk(text: string, what: string): string {
  if (Buffer.byteLength(text, "utf8") > maxChunkBytes) {
    throw new Error(
      `${what} is longer than ${maxChunkBytes} bytes, too long to save in one call.`
    );
  }
  return text;
}

const saveTries = 3;

/**
 * A save sent twice makes two copies, so it is never sent again blind. When
 * its answer is lost, `findSaved` looks for what it made, and the save goes
 * again only when nothing is there.
 */
function saveInOneCall(
  ctx: Context,
  command: string,
  payload: Record<string, unknown>,
  findSaved: () => number | null
): number {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = sendBridge(ctx, command, payload, attemptTimeoutMs);
      requireOk(response, command);
      const id = resultField(response, "id");
      if (typeof id !== "number" || id <= 0) {
        throw new Error(`${command} did not return an id.`);
      }
      return id;
    } catch (error) {
      if (!(error instanceof BridgeTimeoutError) || attempt >= saveTries) {
        throw error;
      }
      const saved = findSaved();
      if (saved !== null) {
        return saved;
      }
    }
  }
}

function savedEntryId(ctx: Context, entry: JournalEntryFixture): number | null {
  const entries = resultField(bridge(ctx, "journal.list", {}), "entries");
  return findSavedId(
    entries,
    (row) => row.date === entry.date && row.title === entry.title
  );
}

function savedChatId(ctx: Context, title: string): number | null {
  const chats = resultField(bridge(ctx, "chat.list", {}), "conversations");
  return findSavedId(chats, (row) => row.title === title);
}

/** The id of the one row that matches, or null when none or several do. */
export function findSavedId(
  rows: unknown,
  matches: (row: Record<string, unknown>) => boolean
): number | null {
  if (!Array.isArray(rows)) {
    return null;
  }
  const found = rows.filter(
    (row): row is Record<string, unknown> =>
      row !== null &&
      typeof row === "object" &&
      matches(row as Record<string, unknown>)
  );
  if (found.length !== 1) {
    return null;
  }
  const { id } = found[0];
  return typeof id === "number" && id > 0 ? id : null;
}

/** Sage embeds the new entries in the background. Wait so no progress shows. */
function waitForEmbeddings(ctx: Context): void {
  const deadline = Date.now() + embedWaitMs;
  while (Date.now() < deadline) {
    const response = bridge(ctx, "embeddings.pending", {});
    const ids = resultField(response, "ids");
    const chatIds = resultField(response, "chatIds");
    const left =
      (Array.isArray(ids) ? ids.length : 0) +
      (Array.isArray(chatIds) ? chatIds.length : 0);
    if (left === 0) {
      return;
    }
    sleep(2000);
  }
  console.warn(
    "Embeddings did not finish. Check that nomic-embed-text is installed."
  );
}

function openRoute(ctx: Context, route: string): void {
  const command = routeCommand(route);
  sendNativeCommand(ctx, command);
  sleep(settleMs);
  // Sending it again clears any focus the new screen took, so no caret shows.
  sendNativeCommand(ctx, command);
}

function capture(ctx: Context, name: string): void {
  for (const appearance of appearances) {
    sendNativeCommand(ctx, `app.appearance:${appearance}`);
    sleep(appearanceSettleMs);
    ensureFrontmost(ctx);
    const file = join(ctx.out, `${name}-${appearance}.png`);
    const result = spawnSync(
      "/usr/sbin/screencapture",
      ["-x", "-o", `-l${ctx.windowId}`, file],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(`screencapture failed for ${name}: ${result.stderr}`);
    }
    checkPngSize(file);
    console.log(`captured ${name}-${appearance}`);
  }
}

/**
 * macOS greys the traffic lights of a window in the background, so each
 * capture waits until Sage is the frontmost app.
 */
function ensureFrontmost(ctx: Context): void {
  if (runHelper(ctx.helper, ["frontmost", String(ctx.pid)]).status === 0) {
    return;
  }
  runHelper(ctx.helper, ["activate", String(ctx.pid)]);
  sleep(500);
  if (runHelper(ctx.helper, ["frontmost", String(ctx.pid)]).status === 0) {
    return;
  }
  console.log("Click the Sage title bar to bring the window to the front.");
  const deadline = Date.now() + focusWaitMs;
  while (Date.now() < deadline) {
    sleep(250);
    if (runHelper(ctx.helper, ["frontmost", String(ctx.pid)]).status === 0) {
      sleep(500);
      return;
    }
  }
  throw new Error("Sage never came to the front.");
}

/** The PNG must be the window at 1x or 2x, not a wallpaper or a blank. */
export function isWindowPngSize(width: number, height: number): boolean {
  return [1, 2].some(
    (scale) =>
      width === windowSize.width * scale && height === windowSize.height * scale
  );
}

function checkPngSize(file: string): void {
  const header = Buffer.alloc(24);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!isWindowPngSize(width, height)) {
    throw new Error(
      `${file} is ${width}×${height}, not the ${windowSize.width}×${windowSize.height} window.`
    );
  }
}

function windowIdFor(helper: string, pid: number): number {
  const result = runHelper(helper, ["window-id", String(pid)]);
  const id = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isInteger(id) || id <= 0) {
    throw new Error(`No Sage window found: ${result.stderr || result.stdout}`);
  }
  return id;
}

function runHelper(helper: string, args: string[]) {
  return spawnSync(helper, args, { encoding: "utf8" });
}

/**
 * A command name Sage does nothing with. Sending it after a real command
 * proves the real one has run, because the automation server takes one
 * command per frame, in order, and publishes that frame's snapshot before it
 * takes the next.
 */
export const syncCommand = "app.sync";
const queueWaitMs = 5000;

/**
 * Sends a native command and checks that the app ran it. A name the
 * automation server refuses only shows up as an error line in the snapshot,
 * and the shot would quietly show the wrong screen.
 */
function sendNativeCommand(ctx: Context, name: string): void {
  automate(ctx.automation, ["native-command", name]);
  automate(ctx.automation, ["native-command", syncCommand]);
  waitForEmptyQueue(ctx.automation);
  automate(ctx.automation, [
    "assert",
    "--absent",
    "--timeout-ms",
    "1000",
    "name=InvalidCommand",
  ]);
}

/** Queued commands wait in `command-<n>.txt` files until the app takes them. */
const queuedCommandFile = /^command-\d+\.txt$/u;

export function isQueuedCommandFile(name: string): boolean {
  return queuedCommandFile.test(name);
}

function waitForEmptyQueue(automation: Automation): void {
  const deadline = Date.now() + queueWaitMs;
  while (readdirSync(automation.dir).some(isQueuedCommandFile)) {
    if (Date.now() > deadline) {
      throw new Error("Sage stopped taking automation commands.");
    }
    sleep(25);
  }
}

function automate(automation: Automation, args: string[]): void {
  const result = spawnSync("native", ["automate", ...args], {
    cwd: automation.cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `native automate ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
}

/**
 * Commands that change nothing when sent twice. The page makes its own bridge
 * calls, such as Dream's poll of `dream.status`, and the automation server
 * keeps only the last response, so an answer can be lost. These are sent
 * again when that happens. A save looks for what it made first
 * (`saveInOneCall`), and a first password asks `lock.status`.
 */
export const repeatSafeCommands: ReadonlySet<string> = new Set([
  "chat.list",
  "embeddings.pending",
  "embeddings.status",
  "journal.list",
  "lock.setTouchId",
  "lock.status",
  "ollama.models",
  "ollama.setupStatus",
  "onboarding.remindersOff",
  "onboarding.save",
]);

const attemptTimeoutMs = 5000;
const attempts = 6;
let requestCount = 0;

function bridge(
  ctx: Context,
  command: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const response = sendBridge(ctx, command, payload);
  requireOk(response, command);
  return response;
}

/**
 * Sends one bridge call and returns its answer, ok or not. `timeoutMs` sets
 * how long to wait for a command that is not sent again.
 */
function sendBridge(
  ctx: Context,
  command: string,
  payload: Record<string, unknown>,
  timeoutMs?: number
): Record<string, unknown> {
  checkBridgeCall(command, payload);
  const tries = repeatSafeCommands.has(command) ? attempts : 1;
  for (let attempt = 1; ; attempt += 1) {
    requestCount += 1;
    try {
      return callBridge(
        ctx.automation,
        command,
        payload,
        `shot-${command}-${Date.now()}-${requestCount}`,
        isMatchingId,
        tries > 1 ? attemptTimeoutMs : timeoutMs
      );
    } catch (error) {
      if (!(error instanceof BridgeTimeoutError) || attempt >= tries) {
        throw error;
      }
    }
  }
}

/**
 * Setting a first password cannot be sent twice, so when its answer is lost,
 * `lock.status` says whether it took.
 */
function setPassword(ctx: Context, password: string): void {
  try {
    bridge(ctx, "lock.setPassword", { current: null, next: password });
  } catch (error) {
    if (!(error instanceof BridgeTimeoutError)) {
      throw error;
    }
    const status = bridge(ctx, "lock.status", {});
    if (resultField(status, "passwordSet") !== true) {
      throw error;
    }
  }
}

function resultField(response: Record<string, unknown>, key: string): unknown {
  let { result } = response;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  return (result as Record<string, unknown>)[key];
}

function idFor(ids: Map<string, number>, fileName: string): number {
  const id = ids.get(fileName);
  if (id === undefined) {
    throw new Error(`${fileName} was not saved.`);
  }
  return id;
}

function flagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.length === 0 ? null : value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function sleep(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)]);
}

// `import.meta.main` needs Node 24.2, and the agent allows any Node 24.
const runDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  try {
    const stateFile = flagValue("--window-state");
    if (stateFile === null) {
      await main();
    } else {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, windowStateZon());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
