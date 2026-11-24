export type MemoriesTab = "events" | "facts";

export function isMemoriesTab(value: unknown): value is MemoriesTab {
  return value === "events" || value === "facts";
}

export const settingsTabs = ["agent", "models", "security", "data"] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return settingsTabs.some((tab) => tab === value);
}

/** What Chat shows: a new chat, or a saved one. */
export type ChatView = "new" | number;

/**
 * Where Sage is. A journal route with no id is a new entry that has not
 * saved yet.
 */
export type Route =
  | { entryId: number | null; section: "journal" }
  | { chat: ChatView; section: "chat" }
  | { section: "memories"; tab: MemoriesTab }
  | { section: "settings"; tab: SettingsTab };

const idPattern = /^[1-9]\d*$/u;

// Sage opens on a new chat. Bad hashes, the old Home route, and a disabled
// Memories route land here too.
const defaultRoute: Route = { chat: "new", section: "chat" };

export function routeForMemoryFeature(
  route: Route,
  memoryEnabled: boolean
): Route {
  return route.section === "memories" && !memoryEnabled ? defaultRoute : route;
}

export function navigationOverridesPendingMemoryRoute(
  initialState: Route,
  currentState: Route,
  memoryFeatureReady: boolean
): boolean {
  return !(memoryFeatureReady || routesEqual(initialState, currentState));
}

export function parseHash(hash: string): Route {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = trimSlashes(withoutHash);
  if (path.length === 0) {
    return defaultRoute;
  }
  const parts = path.split("/");
  if (parts.length > 2) {
    return defaultRoute;
  }
  // `#/home`, the old first screen, is not a route any more, so it falls to
  // the default with any other unknown hash.
  const [head, idPart] = parts;
  if (head === "journal") {
    return parseJournalRoute(idPart);
  }
  if (head === "chat") {
    return parseChatRoute(idPart);
  }
  if (head === "memories") {
    return parseMemoriesRoute(idPart);
  }
  if (head === "settings") {
    return parseSettingsRoute(idPart);
  }
  return defaultRoute;
}

export function toHash(route: Route): string {
  if (route.section === "journal") {
    return route.entryId === null ? "/journal" : `/journal/${route.entryId}`;
  }
  if (route.section === "memories") {
    return route.tab === "facts" ? "/memories" : `/memories/${route.tab}`;
  }
  if (route.section === "settings") {
    return route.tab === "agent" ? "/settings" : `/settings/${route.tab}`;
  }
  return `/chat/${route.chat}`;
}

/**
 * True when a new chat has just saved, so `/chat/new` becomes `/chat/:id`.
 * That replaces the entry in the history, so Back does not return to a new
 * chat that is gone.
 */
export function isNewChatSaved(prev: Route | null, route: Route): boolean {
  return (
    prev?.section === "chat" &&
    prev.chat === "new" &&
    route.section === "chat" &&
    typeof route.chat === "number"
  );
}

/**
 * True when a new entry has just saved, so `/journal` becomes `/journal/:id`.
 * Like a new chat, that replaces the entry in the history, so Back does not
 * open a blank entry in its place.
 */
export function isNewEntrySaved(prev: Route | null, route: Route): boolean {
  return (
    prev?.section === "journal" &&
    prev.entryId === null &&
    route.section === "journal" &&
    route.entryId !== null
  );
}

/** What Chat does to land on a chat route, given what it shows now. */
export interface ChatRoutePlan {
  /**
   * What to do once Chat shows: start a new chat, open a saved one, or
   * nothing, when that chat is already the one in Chat.
   */
  afterShow: "keep" | "new-chat" | { open: number };
  /** Chat is not on screen yet. */
  showChat: boolean;
}

export function planChatRoute(
  view: ChatView,
  current: {
    onChat: boolean;
    selection: { id: number; kind: "saved" } | { kind: "new" };
  }
): ChatRoutePlan {
  const showChat = !current.onChat;
  if (view === "new") {
    return {
      afterShow: current.selection.kind === "new" ? "keep" : "new-chat",
      showChat,
    };
  }
  const alreadyOpen =
    current.selection.kind === "saved" && current.selection.id === view;
  return {
    afterShow: alreadyOpen ? "keep" : { open: view },
    showChat,
  };
}

export function readRoute(): Route {
  return parseHash(window.location.hash);
}

export function pushRoute(route: Route): void {
  writeHash(route, "push");
}

export function replaceRoute(route: Route): void {
  writeHash(route, "replace");
}

export function hashMatches(route: Route): boolean {
  return window.location.hash === `#${toHash(route)}`;
}

export function routesEqual(left: Route, right: Route): boolean {
  return toHash(left) === toHash(right);
}

/**
 * The route for what is on screen. Journal shows its open entry, or a new one
 * when `entryId` is null. Chat shows its open chat, or a new one.
 */
export function routeFromState(input: {
  chatId: number | null;
  entryId: number | null;
  memoriesTab: MemoriesTab;
  section: "chat" | "journal" | "memories" | "settings";
  settingsTab: SettingsTab;
}): Route {
  if (input.section === "settings") {
    return { section: "settings", tab: input.settingsTab };
  }
  if (input.section === "journal") {
    return { entryId: input.entryId, section: "journal" };
  }
  if (input.section === "memories") {
    return { section: "memories", tab: input.memoriesTab };
  }
  return { chat: input.chatId ?? "new", section: "chat" };
}

function parseJournalRoute(idPart: string | undefined): Route {
  if (idPart === undefined) {
    return { entryId: null, section: "journal" };
  }
  const entryId = parseId(idPart);
  return entryId === null ? defaultRoute : { entryId, section: "journal" };
}

function parseChatRoute(idPart: string | undefined): Route {
  // `#/chat` once showed the list alone. The list is in the sidebar now.
  if (idPart === undefined || idPart === "new") {
    return { chat: "new", section: "chat" };
  }
  const chat = parseId(idPart);
  return chat === null ? defaultRoute : { chat, section: "chat" };
}

function parseMemoriesRoute(idPart: string | undefined): Route {
  if (idPart === undefined || idPart === "facts" || idPart === "profile") {
    return { section: "memories", tab: "facts" };
  }
  if (idPart === "events") {
    return { section: "memories", tab: "events" };
  }
  return defaultRoute;
}

function parseSettingsRoute(idPart: string | undefined): Route {
  if (idPart === undefined) {
    return { section: "settings", tab: "agent" };
  }
  return isSettingsTab(idPart)
    ? { section: "settings", tab: idPart }
    : defaultRoute;
}

function writeHash(route: Route, mode: "push" | "replace"): void {
  const next = `#${toHash(route)}`;
  if (window.location.hash === next) {
    return;
  }
  if (mode === "replace") {
    window.history.replaceState(null, "", next);
    return;
  }
  window.history.pushState(null, "", next);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(start, end);
}

function parseId(raw: string): number | null {
  if (!idPattern.test(raw)) {
    return null;
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return id;
}
