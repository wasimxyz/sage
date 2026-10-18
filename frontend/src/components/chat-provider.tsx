import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
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
  getOllamaStatus,
  isMissingRowError,
  listOllamaModels,
  onDreamFinished,
  startOllamaServer,
} from "@/bridge";
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
import { type ModelsLoad, sameModelsLoad } from "@/lib/chat/models-load";
import { deleteFailure } from "@/lib/delete-errors";
import { handlerErrorMessage } from "@/lib/handler-errors";
import { type OllamaStartLoad, ollamaStartFailed } from "@/lib/ollama-start";
import {
  type CommitResult,
  commitAll,
  isHidden,
  onCommitted,
  restore,
} from "@/lib/pending-deletes";
import { deleteWithUndo, toastTitle } from "@/lib/undoable-delete";

const emptyMeta = {};

export type ChatSelection =
  | { kind: "new"; load: ChatLoadPromise }
  | { focusSeq?: number; id: number; kind: "saved"; load: ChatLoadPromise };

interface ChatState {
  agent: AgentHealth;
  agentToken: string | null;
  contextLength: number;
  contextLengthLocked: boolean;
  conversations: ChatConversationMeta[];
  error: string | null;
  /** True once the chat list has loaded, so the list can show rows, not a gap. */
  listLoaded: boolean;
  models: ModelsLoad;
  ollamaStart: OllamaStartLoad;
  paneKey: number;
  /** Whether the panel beside the list is open. Closing keeps the selection. */
  panelOpen: boolean;
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
  openConversation: (id: number, focus?: { seq: number }) => void;
  recordCreated: (id: number, title: string) => void;
  refreshList: () => Promise<void>;
  renameConversation: (id: number, title: string) => Promise<void>;
  selectModel: (model: string) => void;
  setContextLength: (value: number) => void;
  setPanelOpen: (open: boolean) => void;
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
  const [paneKey, setPaneKey] = useState(0);
  // Chat opens on a new chat, so the first visit shows the panel. After that
  // the panel stays as it was left.
  const [panelOpen, setPanelOpen] = useState(true);
  const [listLoaded, setListLoaded] = useState(false);
  const [models, setModels] = useState<ModelsLoad>({ kind: "loading" });
  const [ollamaStart, setOllamaStart] = useState<OllamaStartLoad>({
    kind: "idle",
  });
  const [prefs, setPrefs] = useState<ChatModelPrefs>(loadChatModelPrefs);
  const [contextLengthLocked, setContextLengthLocked] = useState(false);
  const [agent, setAgent] = useState<AgentHealth>({ kind: "checking" });
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    } catch (caught) {
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

  useEffect(() => {
    let cancelled = false;
    const startedAtMs = Date.now();
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        tick().catch(() => undefined);
      }, delayMs);
    };

    const tick = async () => {
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
      schedule(
        decision.kind === "checking" ? eveStartupPollMs : eveHealthPollMs
      );
    };

    tick().catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
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

  // Reads the Ollama status and, when it answers, the chat model list. The
  // warning and the model picker both render what this lands.
  const refreshModels = useCallback(async () => {
    // Keep the old value when the check says the same thing, so the poll does
    // not re-render every screen that reads Chat.
    const land = (next: ModelsLoad) => {
      setModels((current) => (sameModelsLoad(current, next) ? current : next));
    };
    try {
      const status = await getOllamaStatus();
      if (!status.running) {
        land({ kind: "down" });
        return;
      }
      const names = await listOllamaModels();
      // Ollama answered: a start Sage was waiting on has landed, so the
      // warning drops its spinner (or its failure text) here.
      setOllamaStart((current) =>
        current.kind === "idle" ? current : { kind: "idle" }
      );
      if (names.length === 0) {
        land({ kind: "empty" });
        return;
      }
      land({ kind: "ready", names });
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
    } catch {
      land({ kind: "down" });
    }
  }, []);

  useEffect(() => {
    refreshModels().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshModels().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [refreshModels]);

  // The notice's Start button: the core launches Ollama and answers once the
  // server replies, so the starting notice holds until this resolves.
  const startOllama = useCallback(async () => {
    setOllamaStart({ kind: "starting" });
    try {
      await startOllamaServer();
      await refreshModels();
    } catch (caught) {
      setOllamaStart(ollamaStartFailed(caught));
    }
  }, [refreshModels]);

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
  }, [resetToNewChat]);

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
    (id: number, focus?: { seq: number }) => {
      // A chat that is waiting out its undo window cannot be opened.
      if (isHidden("chat", id)) {
        return;
      }
      setError(null);
      setSelection({
        focusSeq: focus?.seq,
        id,
        kind: "saved",
        load: loadConversation(id),
      });
      setContextLengthLocked(true);
      setPaneKey((current) => current + 1);
      setPanelOpen(true);
    },
    []
  );

  const deleteConversation = useCallback(
    (id: number) => {
      const isSelected = selection.kind === "saved" && selection.id === id;
      // Undo reopens a chat that was on screen, not one the closed panel
      // only remembered.
      const wasOpen = isSelected && panelOpen;
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
    [allConversations, openConversation, panelOpen, resetToNewChat, selection]
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
      selectModel,
      setContextLength,
      setPanelOpen,
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
        listLoaded,
        models,
        ollamaStart,
        paneKey,
        panelOpen,
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
      listLoaded,
      models,
      ollamaStart,
      paneKey,
      panelOpen,
      prefs,
      selection,
    ]
  );

  return <ChatContext value={value}>{children}</ChatContext>;
}
