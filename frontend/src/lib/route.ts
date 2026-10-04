export type MemoriesTab = "events" | "facts";

export function isMemoriesTab(value: unknown): value is MemoriesTab {
  return value === "events" || value === "facts";
}

export const settingsTabs = ["agent", "models", "security", "data"] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return settingsTabs.some((tab) => tab === value);
}

export type Route =
  | { section: "home" }
  | { entryId: number | null; section: "journal" }
  | { conversationId: number | null; section: "chat" }
  | { section: "memories"; tab: MemoriesTab }
  | { section: "settings"; tab: SettingsTab };

const idPattern = /^[1-9]\d*$/;

const defaultRoute: Route = { entryId: null, section: "journal" };

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
  const [head, idPart] = parts;
  if (head === "home" && idPart === undefined) {
    return { section: "home" };
  }
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
  if (route.section === "home") {
    return "/home";
  }
  if (route.section === "journal") {
    return route.entryId === null ? "/journal" : `/journal/${route.entryId}`;
  }
  if (route.section === "memories") {
    return route.tab === "facts" ? "/memories" : `/memories/${route.tab}`;
  }
  if (route.section === "settings") {
    return route.tab === "agent" ? "/settings" : `/settings/${route.tab}`;
  }
  return route.conversationId === null
    ? "/chat"
    : `/chat/${route.conversationId}`;
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

export function routeFromState(input: {
  chatId: number | null;
  detailOpen: boolean;
  entryId: number | null;
  memoriesTab: MemoriesTab;
  section: "chat" | "home" | "journal" | "memories" | "settings";
  settingsTab: SettingsTab;
}): Route {
  if (input.section === "home") {
    return { section: "home" };
  }
  if (input.section === "settings") {
    return { section: "settings", tab: input.settingsTab };
  }
  if (input.section === "journal") {
    return {
      entryId: input.detailOpen ? input.entryId : null,
      section: "journal",
    };
  }
  if (input.section === "memories") {
    return { section: "memories", tab: input.memoriesTab };
  }
  return { conversationId: input.chatId, section: "chat" };
}

function parseJournalRoute(idPart: string | undefined): Route {
  if (idPart === undefined) {
    return { entryId: null, section: "journal" };
  }
  const entryId = parseId(idPart);
  return entryId === null ? defaultRoute : { entryId, section: "journal" };
}

function parseChatRoute(idPart: string | undefined): Route {
  if (idPart === undefined) {
    return { conversationId: null, section: "chat" };
  }
  const conversationId = parseId(idPart);
  return conversationId === null
    ? defaultRoute
    : { conversationId, section: "chat" };
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
