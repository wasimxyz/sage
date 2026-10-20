import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { toast } from "sonner";

import {
  type ChatAgentStatusKind,
  type ChatConversation,
  type ChatConversationMeta,
  chatDelete,
  chatList,
  chatRename,
  chatSavePrefs,
  getChatAgent,
  getChatAgentToken,
  isMissingRowError,
  onDreamFinished,
} from "@/bridge";
import { useOllama } from "@/components/ollama-provider";
import { useHiddenIds } from "@/hooks/use-hidden-ids";
import {
  type AgentHealth,
  agentDownMessage,
  agentHealthDecision,
  eveHealthPollMs,
  eveHealthUrl,
  eveStartupPollMs,
  isEveHealthOk,
  sameAgentHealth,
} from "@/lib/chat/eve-host";
import {
  type ChatLoadPromise,
  emptyChatLoad,
  loadConversation,
  readyChatLoad,
} from "@/lib/chat/load-conversation";
import {
  type ChatModelPrefs,
  DEFAULT_CHAT_MODEL,
  loadChatModelPrefs,
  normalizeChatModelId,
  normalizeContextLength,
  prefsFromConversation,
  saveChatModelPrefs,
} from "@/lib/chat/model-prefs";
import type { ModelsLoad } from "@/lib/chat/models-load";
import { keepsOpenPane } from "@/lib/chat/open-chat";
import { initialPanel, panelReducer } from "@/lib/chat/panel-state";
import { deleteFailure } from "@/lib/delete-errors";
import { handlerErrorMessage } from "@/lib/handler-errors";
import type { OllamaStartLoad } from "@/lib/ollama-start";
import {
  type CommitResult,
  commitAll,
  isHidden,
  onCommitted,
  restore,
} from "@/lib/pending-deletes";
import { deleteWithUndo, toastTitle } from "@/lib/undoable-delete";
import { documentPollHost, startVisiblePoll } from "@/lib/visible-poll";

const emptyMeta = {};

/**
 * A message to scroll to when a chat opens, such as for a search hit. Each
 * request is its own object, so asking for the same message again scrolls
 * again.
 */
export interface ChatFocus {
  seq: number;
}

export type ChatSelection =
  | { kind: "new"; load: ChatLoadPromise }
  | { focus?: ChatFocus; id: number; kind: "saved"; load: ChatLoadPromise };

interface ChatState {
  agent: AgentHealth;
  agentToken: string | null;
  contextLength: number;
  contextLengthLocked: boolean;
  conversations: ChatConversationMeta[];
  error: string | null;
  /** True when the last read of the chat list failed. */
  listFailed: boolean;
  /** True once the chat list has loaded, so the list can show rows, not a gap. */
  listLoaded: boolean;
  models: ModelsLoad;
  ollamaStart: OllamaStartLoad;
  paneKey: number;
  selectedModel: string;
  selection: ChatSelection;
  thinkingEnabled: boolean;
}

interface ChatActions {
  applyConversationPrefs: (conversation: ChatConversation) => void;
  clearError: () => void;
  /** Hide a chat now and delete it when the undo toast closes. */
  deleteConversation: (id: number) => void;
  lockContextLength: () => void;
  newChat: () => void;
  openConversation: (id: number, focus?: ChatFocus) => void;
  recordCreated: (id: number, title: string) => void;
  refreshList: () => Promise<void>;
  renameConversation: (id: number, title: string) => Promise<void>;
  /** Back to an empty chat, with the panel as it is. */
  resetToNewChat: () => void;
  selectModel: (model: string) => void;
  setContextLength: (value: number) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  showError: (message: string) => void;
  startOllama: () => Promise<void>;
}

interface ChatContextValue {
  actions: ChatActions;
  meta: Record<string, never>;
  state: ChatState;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * Whether the panel beside the chat list is open, and whether it fills the
 * window. It has its own context, so opening and closing the panel does not
 * render every screen that reads the chat.
 */
interface ChatPanelContextValue {
  actions: {
    setExpanded: (expanded: boolean) => void;
    setPanelOpen: (open: boolean) => void;
  };
  meta: Record<string, never>;
  state: {
    /** Kept while you visit other screens, and ended when the panel closes. */
    expanded: boolean;
    /** Closing keeps the selection. */
    panelOpen: boolean;
  };
}

const ChatPanelContext = createContext<ChatPanelContextValue | null>(null);

/** The real delete for one chat. The pending-delete store also runs it after a relaunch. */
async function commitChatDelete(id: number): Promise<CommitResult> {
  try {
    await chatDelete(id);
    return "done";
  } catch (caught) {
    const failure = deleteFailure(caught);
    if (failure === "locked") {
      return "retry";
    }
    if (failure === "missing") {
      return "done";
    }
    toast.error(handlerErrorMessage(caught) || "Could not delete this chat.");
    return "failed";
  }
}

async function packagedStartupState(): Promise<{
  downMessage: string;
  sidecar: ChatAgentStatusKind;
}> {
  try {
    const status = await getChatAgent();
    return {
      downMessage: agentDownMessage(status.message),
      sidecar: status.status,
    };
  } catch {
    return {
      downMessage: agentDownMessage(),
      sidecar: "down",
    };
  }
}

async function fetchEveReady(): Promise<boolean> {
  try {
    const response = await fetch(eveHealthUrl());
    if (!response.ok) {
      return false;
    }
    return isEveHealthOk(await response.json());
  } catch {
    return false;
  }
}

export function useChat(): ChatContextValue {
  const value = use(ChatContext);
  if (!value) {
    throw new Error("ChatProvider is missing.");
  }
  return value;
}

export function useChatPanel(): ChatPanelContextValue {
  const value = use(ChatPanelContext);
  if (!value) {
    throw new Error("ChatProvider is missing.");
  }
  return value;
}

export function isChatComposerLocked(state: {
  agent: ChatState["agent"];
  dreaming?: boolean;
  models: ChatState["models"];
}): boolean {
  return (
    state.dreaming === true ||
    state.agent.kind === "down" ||
    state.models.kind === "down" ||
    state.models.kind === "empty"
  );
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [allConversations, setConversations] = useState<ChatConversationMeta[]>(
    []
  );
  // Chats waiting out their undo window stay out of the list. When a delete
  // finishes, the list drops its copy too.
  const hiddenChatIds = useHiddenIds("chat");
  const conversations = useMemo(
    () =>
      hiddenChatIds.size === 0
        ? allConversations
        : allConversations.filter((row) => !hiddenChatIds.has(row.id)),
    [allConversations, hiddenChatIds]
  );
  useEffect(
    () =>
      onCommitted((kind, id) => {
        if (kind === "chat") {
          setConversations((current) => current.filter((row) => row.id !== id));
        }
      }),
    []
  );
  const [selection, setSelection] = useState<ChatSelection>({
    kind: "new",
    load: emptyChatLoad,
  });
  const selectionRef = useRef(selection);
  const [paneKey, setPaneKey] = useState(0);
  // Chat opens on a new chat, so the first visit shows the panel. After that
  // the panel stays as it was left.
  const [panel, dispatchPanel] = useReducer(panelReducer, initialPanel);
  const panelOpenRef = useRef(panel.open);
  const [listLoaded, setListLoaded] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const {
    actions: { startOllama },
    state: { models, ollamaStart },
  } = useOllama();
  const [prefs, setPrefs] = useState<ChatModelPrefs>(loadChatModelPrefs);
  const [contextLengthLocked, setContextLengthLocked] = useState(false);
  const [agent, setAgent] = useState<AgentHealth>({ kind: "checking" });
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    panelOpenRef.current = panel.open;
  }, [panel.open]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const setPanelOpen = useCallback((open: boolean) => {
    dispatchPanel({ type: open ? "open" : "close" });
  }, []);

  const setExpanded = useCallback((expanded: boolean) => {
    dispatchPanel({ expanded, type: "expand" });
  }, []);

  const showError = useCallback((message: string) => {
    setError(message);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const updatePrefs = useCallback((patch: Partial<ChatModelPrefs>) => {
    setPrefs((current) => {
      const next = {
        ...current,
        ...patch,
        contextLength: normalizeContextLength(
          patch.contextLength ?? current.contextLength
        ),
        model: normalizeChatModelId(patch.model ?? current.model),
      };
      saveChatModelPrefs(next);
      return next;
    });
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await chatList());
      setListFailed(false);
    } catch (caught) {
      setListFailed(true);
      setError(
        caught instanceof Error ? caught.message : "Could not load chats."
      );
    }
    setListLoaded(true);
  }, []);

  useEffect(() => {
    // A delete that was waiting when the app locked or quit runs before the
    // list loads.
    restore("chat", commitChatDelete);
    commitAll("chat")
      .then(() => refreshList())
      .catch(() => undefined);
  }, [refreshList]);

  useEffect(
    () =>
      onDreamFinished(() => {
        refreshList().catch(() => undefined);
      }),
    [refreshList]
  );

  // A hidden window skips the health check and runs one when it comes back.
  useEffect(() => {
    let cancelled = false;
    const startedAtMs = Date.now();
    let delayMs = eveStartupPollMs;

    const check = async () => {
      // A packaged build asks `chat.agent` on every poll, healthy or not:
      // another program bound to 2001 can answer health, so only that status
      // says whether Sage started the process answering Chat. In `make dev`
      // the agent starts on its own and health alone decides. The two reads
      // are independent, so they run together; both swallow their own errors.
      const [healthOk, startup] = await Promise.all([
        fetchEveReady(),
        import.meta.env.DEV
          ? { downMessage: agentDownMessage(), sidecar: null }
          : packagedStartupState(),
      ]);
      if (cancelled) {
        return;
      }
      const decision = agentHealthDecision({
        downMessage: startup.downMessage,
        healthOk,
        nowMs: Date.now(),
        sidecar: startup.sidecar,
        startedAtMs,
      });
      setAgent((current) =>
        sameAgentHealth(current, decision) ? current : decision
      );
      delayMs =
        decision.kind === "checking" ? eveStartupPollMs : eveHealthPollMs;
    };

    const stop = startVisiblePoll({
      check,
      delayMs: () => delayMs,
      host: documentPollHost,
      leading: true,
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const token = await getChatAgentToken();
        if (cancelled) {
          return;
        }
        if (token === null) {
          timer = window.setTimeout(() => {
            load().catch(() => undefined);
          }, eveStartupPollMs);
          return;
        }
        setAgentToken(token);
      } catch {
        if (cancelled) {
          return;
        }
        timer = window.setTimeout(() => {
          load().catch(() => undefined);
        }, eveStartupPollMs);
      }
    };

    load().catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  // With no model chosen yet, pick one as soon as Ollama lists its models,
  // and remember it for the next new chat.
  const noModelChosen = prefs.model.length === 0;
  useEffect(() => {
    if (!noModelChosen || models.kind !== "ready") {
      return;
    }
    const { names } = models;
    setPrefs((current) => {
      if (current.model.length > 0) {
        return current;
      }
      const model = names.includes(DEFAULT_CHAT_MODEL)
        ? DEFAULT_CHAT_MODEL
        : names[0];
      const next = { ...current, model };
      saveChatModelPrefs(next);
      return next;
    });
  }, [models, noModelChosen]);

  const applyConversationPrefs = useCallback(
    (conversation: ChatConversation) => {
      setPrefs(prefsFromConversation(conversation, loadChatModelPrefs()));
      setContextLengthLocked(true);
    },
    []
  );

  const persistSavedPrefs = useCallback(
    (next: ChatModelPrefs) => {
      if (selection.kind !== "saved") {
        return;
      }
      chatSavePrefs({
        contextLength: next.contextLength,
        id: selection.id,
        model: normalizeChatModelId(next.model),
        thinking: next.thinking,
      }).catch((caught: unknown) => {
        if (isMissingRowError(caught)) {
          return;
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not save the model settings."
        );
      });
    },
    [selection]
  );

  // Back to an empty chat, with the panel as it is.
  const resetToNewChat = useCallback(() => {
    setError(null);
    setSelection({ kind: "new", load: emptyChatLoad });
    setPrefs(loadChatModelPrefs());
    setContextLengthLocked(false);
    setPaneKey((current) => current + 1);
  }, []);

  const newChat = useCallback(() => {
    resetToNewChat();
    setPanelOpen(true);
  }, [resetToNewChat, setPanelOpen]);

  const renameConversation = useCallback(async (id: number, title: string) => {
    try {
      await chatRename({ id, title });
      setConversations((current) =>
        current.map((row) => (row.id === id ? { ...row, title } : row))
      );
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Could not rename this chat."
      );
      throw caught;
    }
  }, []);

  const openConversation = useCallback(
    (id: number, focus?: ChatFocus) => {
      // A chat that is waiting out its undo window cannot be opened.
      if (isHidden("chat", id)) {
        return;
      }
      // The chat is already open, such as from Home or a search hit. Keep its
      // pane, so a reply that is still coming in is not cut off. Show the
      // panel, and scroll to the hit if there is one.
      if (keepsOpenPane(selectionRef.current, id)) {
        if (focus) {
          setSelection((current) =>
            current.kind === "saved" && current.id === id
              ? { ...current, focus }
              : current
          );
        }
        setPanelOpen(true);
        return;
      }
      setError(null);
      setSelection({
        focus,
        id,
        kind: "saved",
        load: loadConversation(id),
      });
      setContextLengthLocked(true);
      setPaneKey((current) => current + 1);
      setPanelOpen(true);
    },
    [setPanelOpen]
  );

  const deleteConversation = useCallback(
    (id: number) => {
      const isSelected = selection.kind === "saved" && selection.id === id;
      // Undo reopens a chat that was on screen, not one the closed panel
      // only remembered.
      const wasOpen = isSelected && panelOpenRef.current;
      const title = allConversations.find((row) => row.id === id)?.title ?? "";
      if (isSelected) {
        resetToNewChat();
      }
      deleteWithUndo({
        commit: () => commitChatDelete(id),
        id,
        kind: "chat",
        message: `“${toastTitle(title, "Untitled chat")}” deleted.`,
        onUndo: () => {
          if (wasOpen) {
            openConversation(id);
          }
        },
      });
    },
    [allConversations, openConversation, resetToNewChat, selection]
  );

  const recordCreated = useCallback(
    (id: number, title: string) => {
      const updatedAt = new Date().toISOString();
      setConversations((current) => {
        const without = current.filter((row) => row.id !== id);
        return [{ id, title, updatedAt }, ...without];
      });
      setSelection((current) => {
        if (current.kind === "saved") {
          return current.id === id ? current : { ...current, id };
        }
        return {
          id,
          kind: "saved",
          load: readyChatLoad({
            contextLength: prefs.contextLength,
            createdAt: updatedAt,
            events: [],
            eveSessionId: null,
            id,
            model: prefs.model,
            streamIndex: 0,
            thinking: prefs.thinking,
            title,
            updatedAt,
          }),
        };
      });
      setContextLengthLocked(true);
    },
    [prefs.contextLength, prefs.model, prefs.thinking]
  );

  const selectModel = useCallback(
    (model: string) => {
      const next = { ...prefs, model };
      updatePrefs({ model });
      persistSavedPrefs(next);
    },
    [persistSavedPrefs, prefs, updatePrefs]
  );

  const setThinkingEnabled = useCallback(
    (thinking: boolean) => {
      const next = { ...prefs, thinking };
      updatePrefs({ thinking });
      persistSavedPrefs(next);
    },
    [persistSavedPrefs, prefs, updatePrefs]
  );

  const setContextLength = useCallback(
    (contextLength: number) => {
      if (contextLengthLocked) {
        return;
      }
      const normalized = normalizeContextLength(contextLength);
      const next = { ...prefs, contextLength: normalized };
      updatePrefs({ contextLength: normalized });
      persistSavedPrefs(next);
    },
    [contextLengthLocked, persistSavedPrefs, prefs, updatePrefs]
  );

  const lockContextLength = useCallback(() => {
    setContextLengthLocked(true);
  }, []);

  const actions = useMemo<ChatActions>(
    () => ({
      applyConversationPrefs,
      clearError,
      deleteConversation,
      lockContextLength,
      newChat,
      openConversation,
      recordCreated,
      refreshList,
      renameConversation,
      resetToNewChat,
      selectModel,
      setContextLength,
      setThinkingEnabled,
      showError,
      startOllama,
    }),
    [
      applyConversationPrefs,
      clearError,
      deleteConversation,
      lockContextLength,
      newChat,
      openConversation,
      recordCreated,
      refreshList,
      renameConversation,
      resetToNewChat,
      selectModel,
      setContextLength,
      setThinkingEnabled,
      showError,
      startOllama,
    ]
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      actions,
      meta: emptyMeta,
      state: {
        agent,
        agentToken,
        contextLength: prefs.contextLength,
        contextLengthLocked,
        conversations,
        error,
        listFailed,
        listLoaded,
        models,
        ollamaStart,
        paneKey,
        selectedModel: prefs.model,
        selection,
        thinkingEnabled: prefs.thinking,
      },
    }),
    [
      actions,
      agent,
      agentToken,
      contextLengthLocked,
      conversations,
      error,
      listFailed,
      listLoaded,
      models,
      ollamaStart,
      paneKey,
      prefs,
      selection,
    ]
  );

  const panelValue = useMemo<ChatPanelContextValue>(
    () => ({
      actions: { setExpanded, setPanelOpen },
      meta: emptyMeta,
      state: { expanded: panel.expanded, panelOpen: panel.open },
    }),
    [panel.expanded, panel.open, setExpanded, setPanelOpen]
  );

  return (
    <ChatContext value={value}>
      <ChatPanelContext value={panelValue}>{children}</ChatPanelContext>
    </ChatContext>
  );
}
