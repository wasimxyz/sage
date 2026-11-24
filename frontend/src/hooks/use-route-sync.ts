import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useChat } from "@/components/chat-provider";
import {
  type JournalActions,
  type JournalViewState,
  useJournalActions,
  useJournalView,
} from "@/components/journal-context";
import { useMemories } from "@/components/memories-provider";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { useSettings } from "@/components/settings-context";
import {
  hashMatches,
  isNewChatSaved,
  isNewEntrySaved,
  navigationOverridesPendingMemoryRoute,
  planChatRoute,
  pushRoute,
  type Route,
  readRoute,
  replaceRoute,
  routeForMemoryFeature,
  routeFromState,
  routesEqual,
} from "@/lib/route";

interface JournalApi {
  actions: JournalActions;
  state: JournalViewState;
}
type ChatApi = ReturnType<typeof useChat>;
type MemoriesApi = ReturnType<typeof useMemories>;
type SettingsApi = ReturnType<typeof useSettings>;

/**
 * Keeps the URL hash in sync with the current section, open journal entry,
 * open chat, Memories tab, and settings tab so Cmd+R, back/forward, and an
 * unlock restore the same place. Answers true once the hash Sage opened with
 * has been applied, so the screen on show is the real one.
 */
export function useRouteSync(): boolean {
  const [applied, setApplied] = useState(false);
  const journalActions = useJournalActions();
  const journalView = useJournalView();
  const journal = useMemo<JournalApi>(
    () => ({ actions: journalActions, state: journalView }),
    [journalActions, journalView]
  );
  const chat = useChat();
  const memories = useMemories();
  const settings = useSettings();
  const { memoryEnabled, ready: memoryFeatureReady } = useMemoryFeature();

  const journalRef = useRef(journal);
  journalRef.current = journal;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const flagsRef = useRef({ applying: false, ready: false });
  const applyGenRef = useRef(0);
  const prevRouteRef = useRef<Route | null>(null);
  const paneKeyRef = useRef(chat.state.paneKey);
  const initialUiRouteRef = useRef<Route | null>(null);
  const pendingMemoryRouteRef = useRef(false);

  const applyFromHash = useCallback(
    async (gen: number) => {
      const requestedRoute = readRoute();
      if (!memoryFeatureReady && requestedRoute.section === "memories") {
        pendingMemoryRouteRef.current = true;
        return;
      }
      flagsRef.current.applying = true;
      try {
        if (gen !== applyGenRef.current) {
          return;
        }
        await applyHashRoute(
          journalRef.current,
          chatRef.current,
          memoriesRef.current,
          settingsRef.current,
          () => gen !== applyGenRef.current,
          memoryEnabled
        );
      } finally {
        if (gen === applyGenRef.current) {
          flagsRef.current.applying = false;
          flagsRef.current.ready = true;
          setApplied(true);
        }
      }
    },
    [memoryEnabled, memoryFeatureReady]
  );

  useEffect(() => {
    const gen = applyGenRef.current + 1;
    applyGenRef.current = gen;
    applyFromHash(gen).catch(() => undefined);

    const onNav = () => {
      const nextGen = applyGenRef.current + 1;
      applyGenRef.current = nextGen;
      applyFromHash(nextGen).catch(() => undefined);
    };
    // pushState does not fire hashchange; back/forward fires popstate.
    // Hash links and some WebView reloads fire hashchange. Listen to both.
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      applyGenRef.current += 1;
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, [applyFromHash]);

  const { section, selection } = journal.state;
  const { paneKey, selection: chatSelection } = chat.state;
  const { tab: memoriesTab } = memories.state;
  const { tab: settingsTab } = settings.state;
  const entryId = selection.kind === "id" ? selection.id : null;
  const chatId = chatSelection.kind === "saved" ? chatSelection.id : null;

  useEffect(() => {
    const route = routeFromState({
      chatId,
      entryId,
      memoriesTab,
      section,
      settingsTab,
    });
    const initialRoute = initialUiRouteRef.current;
    if (initialRoute === null) {
      initialUiRouteRef.current = route;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: applyFromHash mutates these refs across async route application
    if (flagsRef.current.applying) {
      return;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the initial hash effect updates ready before later navigation
    if (!flagsRef.current.ready) {
      if (
        // biome-ignore lint/suspicious/noUnnecessaryConditions: applyFromHash marks a deferred Memories hash here
        pendingMemoryRouteRef.current &&
        initialRoute !== null &&
        navigationOverridesPendingMemoryRoute(
          initialRoute,
          route,
          memoryFeatureReady
        )
      ) {
        pendingMemoryRouteRef.current = false;
        flagsRef.current.ready = true;
        applyGenRef.current += 1;
        prevRouteRef.current = route;
        paneKeyRef.current = paneKey;
        replaceRoute(route);
        setApplied(true);
      }
      return;
    }
    if (hashMatches(route)) {
      prevRouteRef.current = route;
      paneKeyRef.current = paneKey;
      return;
    }
    const prev = prevRouteRef.current;
    const paneKeyChanged = paneKeyRef.current !== paneKey;
    prevRouteRef.current = route;
    paneKeyRef.current = paneKey;
    if (shouldReplaceHash(prev, route, paneKeyChanged)) {
      replaceRoute(route);
      return;
    }
    pushRoute(route);
  }, [
    chatId,
    entryId,
    memoryFeatureReady,
    memoriesTab,
    paneKey,
    section,
    settingsTab,
  ]);

  return applied;
}

function routeFromProviders(
  journal: JournalApi,
  chat: ChatApi,
  memories: MemoriesApi,
  settings: SettingsApi
): Route {
  return routeFromState({
    chatId:
      chat.state.selection.kind === "saved" ? chat.state.selection.id : null,
    entryId:
      journal.state.selection.kind === "id" ? journal.state.selection.id : null,
    memoriesTab: memories.state.tab,
    section: journal.state.section,
    settingsTab: settings.state.tab,
  });
}

async function applyHashRoute(
  journal: JournalApi,
  chat: ChatApi,
  memories: MemoriesApi,
  settings: SettingsApi,
  isStale: () => boolean,
  memoryEnabled: boolean
): Promise<void> {
  const requestedRoute = readRoute();
  const route = routeForMemoryFeature(requestedRoute, memoryEnabled);
  // An empty hash, the old `#/home`, a disabled Memories route, or another
  // hash that is not a route lands somewhere else. Write where, so the
  // address and the history show the screen.
  if (!hashMatches(route)) {
    replaceRoute(route);
  }
  const current = routeFromProviders(journal, chat, memories, settings);
  if (routesEqual(route, current)) {
    return;
  }
  if (route.section === "journal") {
    await applyJournalHash(route, journal);
    return;
  }
  if (route.section === "memories") {
    await applyMemoriesHash(route, journal, memories, isStale);
    return;
  }
  if (route.section === "settings") {
    await applySettingsHash(route, journal, settings, isStale);
    return;
  }
  await applyChatHash(route, current, journal, chat, isStale);
}

async function applyJournalHash(
  route: Extract<Route, { section: "journal" }>,
  journal: JournalApi
): Promise<void> {
  // `/journal` is a new entry. Back to it from a saved entry starts one.
  if (route.entryId === null) {
    if (journal.state.selection.kind === "draft") {
      await journal.actions.showJournal();
      return;
    }
    await journal.actions.startDraft();
    return;
  }
  await journal.actions.select(route.entryId);
}

async function applyMemoriesHash(
  route: Extract<Route, { section: "memories" }>,
  journal: JournalApi,
  memories: MemoriesApi,
  isStale: () => boolean
): Promise<void> {
  if (journal.state.section !== "memories") {
    await journal.actions.showMemories();
    if (isStale()) {
      return;
    }
  }
  memories.actions.setTab(route.tab);
}

async function applySettingsHash(
  route: Extract<Route, { section: "settings" }>,
  journal: JournalApi,
  settings: SettingsApi,
  isStale: () => boolean
): Promise<void> {
  if (journal.state.section !== "settings") {
    await journal.actions.showSettings();
    if (isStale()) {
      return;
    }
  }
  settings.actions.setTab(route.tab);
}

async function applyChatHash(
  route: Extract<Route, { section: "chat" }>,
  current: Route,
  journal: JournalApi,
  chat: ChatApi,
  isStale: () => boolean
): Promise<void> {
  const { selection } = chat.state;
  const plan = planChatRoute(route.chat, {
    onChat: current.section === "chat",
    selection:
      selection.kind === "saved"
        ? { id: selection.id, kind: "saved" }
        : { kind: "new" },
  });
  if (plan.showChat) {
    await journal.actions.showChat();
    if (isStale()) {
      return;
    }
  }
  if (plan.afterShow === "keep") {
    return;
  }
  if (plan.afterShow === "new-chat") {
    chat.actions.newChat();
    return;
  }
  chat.actions.openConversation(plan.afterShow.open);
}

function shouldReplaceHash(
  prev: Route | null,
  route: Route,
  paneKeyChanged: boolean
): boolean {
  if (window.location.hash.length === 0) {
    return true;
  }
  if (isNewEntrySaved(prev, route)) {
    return true;
  }
  return !paneKeyChanged && isNewChatSaved(prev, route);
}
