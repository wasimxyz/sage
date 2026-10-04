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
import { handlerErrorMessage } from "@/lib/handler-errors.ts";

const emptyMeta = {};

const ollamaStartFailedMessage = "Could not start Ollama.";

type ChatSelection =
  | { kind: "new"; load: ChatLoadPromise }
  | { focusSeq?: number; id: number; kind: "saved"; load: ChatLoadPromise };

type ModelsLoad =
  | { kind: "loading" }
  | { kind: "down" }
  | { kind: "empty" }
  | { kind: "ready"; names: string[] };

/// The Ollama notice's Start button: `starting` keeps that notice up until a
/// status read reports the server, and `failed` carries the reason it did not.
export type OllamaStartLoad =
  | { kind: "failed"; message: string }
  | { kind: "idle" }
  | { kind: "starting" };

interface ChatState {
  agent: AgentHealth;
  agentToken: string | null;
  contextLength: number;
  contextLengthLocked: boolean;
  conversations: ChatConversationMeta[];
  error: string | null;
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
  deleteConversation: (id: number) => Promise<void>;
  lockContextLength: () => void;
  newChat: () => void;
  openConversation: (id: number, focus?: { seq: number }) => void;
  recordCreated: (id: number, title: string) => void;
  refreshList: () => Promise<void>;
  renameConversation: (id: number, title: string) => Promise<void>;
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
  const [conversations, setConversations] = useState<ChatConversationMeta[]>(
    []
  );
  const [selection, setSelection] = useState<ChatSelection>({
    kind: "new",
    load: emptyChatLoad,
  });
  const [paneKey, setPaneKey] = useState(0);
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
  }, []);

  useEffect(() => {
    refreshList().catch(() => undefined);
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
    try {
      const status = await getOllamaStatus();
      if (!status.running) {
        setModels({ kind: "down" });
        return;
      }
      const names = await listOllamaModels();
      // Ollama answered: a start Sage was waiting on has landed, so the
      // warning drops its spinner (or its failure text) here.
      setOllamaStart((current) =>
        current.kind === "idle" ? current : { kind: "idle" }
      );
      if (names.length === 0) {
        setModels({ kind: "empty" });
        return;
      }
      setModels({ kind: "ready", names });
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
      setModels({ kind: "down" });
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
      setOllamaStart({
        kind: "failed",
        message: handlerErrorMessage(caught) || ollamaStartFailedMessage,
      });
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

  const newChat = useCallback(() => {
    setError(null);
    setSelection({ kind: "new", load: emptyChatLoad });
    setPrefs(loadChatModelPrefs());
    setContextLengthLocked(false);
    setPaneKey((current) => current + 1);
  }, []);

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

  const deleteConversation = useCallback(
    async (id: number) => {
      try {
        await chatDelete(id);
        setConversations((current) => current.filter((row) => row.id !== id));
        if (selection.kind === "saved" && selection.id === id) {
          newChat();
        }
        toast("Chat deleted.");
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not delete this chat."
        );
        throw caught;
      }
    },
    [newChat, selection]
  );

  const openConversation = useCallback(
    (id: number, focus?: { seq: number }) => {
      setError(null);
      setSelection({
        focusSeq: focus?.seq,
        id,
        kind: "saved",
        load: loadConversation(id),
      });
      setContextLengthLocked(true);
      setPaneKey((current) => current + 1);
    },
    []
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
      models,
      ollamaStart,
      paneKey,
      prefs,
      selection,
    ]
  );

  return <ChatContext value={value}>{children}</ChatContext>;
}
