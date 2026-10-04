import type { ChatStatus } from "ai";
import type {
  ClientSessionState,
  EveAgentReducerEvent,
  MessageStreamEvent,
} from "eve/client";
import { type EveMessage, useEveAgent } from "eve/react";
import { MessageCircleIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ComponentProps,
  type MutableRefObject,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { type ChatConversation, chatSave, isMissingRowError } from "@/bridge";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { AssistantPending } from "@/components/chat/assistant-pending";
import { ChatDraftProvider, useChatDraft } from "@/components/chat/chat-draft";
import {
  ChatAgentAlert,
  ChatErrorAlert,
  ChatOllamaAlert,
} from "@/components/chat/chat-error-alert";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ModelPicker } from "@/components/chat/model-picker";
import {
  ASSISTANT_PROSE_INSET,
  ASSISTANT_PROSE_SPACING,
  TRANSCRIPT_COLUMN_CLASS,
  TRANSCRIPT_FADE_CLASS,
  TRANSCRIPT_GUTTER_CLASS,
} from "@/components/chat/transcript-column";
import { isChatComposerLocked, useChat } from "@/components/chat-provider";
import { useDream } from "@/components/dream-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { shouldShowAssistantPending } from "@/lib/chat/assistant-pending";
import {
  formatChatSaveError,
  formatChatSendError,
} from "@/lib/chat/chat-errors";
import {
  agentDownMessage,
  eveHost,
  withChatAuthorization,
} from "@/lib/chat/eve-host";
import {
  loadChatModelPrefs,
  normalizeChatModelId,
  prefsFromConversation,
} from "@/lib/chat/model-prefs";
import {
  historyClientContext,
  isSessionNotActiveError,
  projectedMessageIdAtSeq,
  sessionNamespacingReducer,
} from "@/lib/chat/session-recovery";
import { cn } from "@/lib/utils";

interface PersistPatch {
  events?: EveAgentReducerEvent[];
  eveSessionId?: string | null;
  streamIndex?: number;
  title?: string;
}

function eventsFromConversation(
  conversation: ChatConversation | null
): EveAgentReducerEvent[] {
  return (conversation?.events ?? []) as EveAgentReducerEvent[];
}

function commonPrefixLength(
  left: readonly unknown[],
  right: readonly unknown[]
): number {
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && JSON.stringify(left[i]) === JSON.stringify(right[i])) {
    i += 1;
  }
  return i;
}

function mergeSession(
  previous: ClientSessionState | undefined,
  next: PersistPatch
): ClientSessionState | undefined {
  if (next.eveSessionId === undefined && next.streamIndex === undefined) {
    return previous;
  }
  const sessionId =
    next.eveSessionId === undefined
      ? (previous?.sessionId ?? null)
      : next.eveSessionId;
  if (sessionId === null) {
    return undefined;
  }
  return {
    sessionId,
    streamIndex: next.streamIndex ?? previous?.streamIndex ?? 0,
  };
}

const titleLimit = 60;

const expiredSessionRestoredMessage =
  "The previous session expired. History was restored into a fresh session.";

export function ChatScreen() {
  const {
    state: { paneKey },
  } = useChat();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ChatDraftProvider key={paneKey}>
        <Suspense fallback={<ChatSessionFallback />}>
          <ChatSession />
        </Suspense>
      </ChatDraftProvider>
    </div>
  );
}

function ChatSession() {
  const {
    state: { agentToken, selection },
  } = useChat();
  const result = use(selection.load);
  if (result.kind === "failed") {
    return <ChatLoadFailed message={result.message} />;
  }
  // A restored session resumes its stream on mount. Wait for the token so
  // that first request is not rejected.
  if (result.conversation?.eveSessionId && agentToken === null) {
    return <ChatSessionFallback />;
  }
  return (
    <ChatTurn
      agentToken={agentToken}
      conversation={result.conversation}
      focusSeq={selection.kind === "saved" ? selection.focusSeq : undefined}
    />
  );
}

function ChatTurn({
  agentToken,
  conversation,
  focusSeq,
}: {
  agentToken: string | null;
  conversation: ChatConversation | null;
  focusSeq?: number;
}) {
  const {
    actions: { applyConversationPrefs, recordCreated, refreshList, showError },
    state: { agent: agentLoad, contextLength, selectedModel, thinkingEnabled },
  } = useChat();
  const {
    actions: { setText },
  } = useChatDraft();
  const idRef = useRef<number | null>(conversation?.id ?? null);
  const titleRef = useRef(conversation?.title ?? "");
  const eventsRef = useRef<EveAgentReducerEvent[]>(
    eventsFromConversation(conversation)
  );
  const persistedEventsRef = useRef<EveAgentReducerEvent[]>(
    eventsFromConversation(conversation)
  );
  const sessionRef = useRef<ClientSessionState | undefined>(
    sessionFromRow(conversation)
  );
  const persistChainRef = useRef(Promise.resolve());
  const aliveRef = useRef<boolean>(true);
  const recoveringRef = useRef<boolean>(false);
  const recoveredRef = useRef<{ used: boolean }>({ used: false });
  const pendingActionRef = useRef<"send" | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);
  const pendingResendRef = useRef<string | null>(null);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const initialPrefs = conversation
    ? prefsFromConversation(conversation, loadChatModelPrefs())
    : {
        contextLength,
        model: selectedModel,
        thinking: thinkingEnabled,
      };
  const selectedModelRef = useRef(initialPrefs.model);
  const thinkingEnabledRef = useRef(initialPrefs.thinking);
  const contextLengthRef = useRef(initialPrefs.contextLength);
  const pickerRestored = useRef(conversation === null);
  if (pickerRestored.current) {
    selectedModelRef.current = selectedModel;
    thinkingEnabledRef.current = thinkingEnabled;
    contextLengthRef.current = contextLength;
  }

  useLayoutEffect(() => {
    if (conversation) {
      applyConversationPrefs(conversation);
    }
    pickerRestored.current = true;
  }, [applyConversationPrefs, conversation]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const persist = useCallback(
    (next: PersistPatch) => {
      persistChainRef.current = persistChainRef.current
        .catch(() => undefined)
        .then(() =>
          applyPersistPatch(next, {
            aliveRef,
            contextLengthRef,
            eventsRef,
            idRef,
            persistedEventsRef,
            recordCreated,
            refreshList,
            selectedModelRef,
            sessionRef,
            thinkingEnabledRef,
            titleRef,
          })
        );
      return persistChainRef.current;
    },
    [recordCreated, refreshList]
  );

  const persistLater = useCallback(
    (next: PersistPatch) => {
      persist(next).catch((error: unknown) => {
        if (!isPaneAlive(aliveRef) || isMissingRowError(error)) {
          return;
        }
        showError(formatChatSaveError(error));
      });
    },
    [persist, showError]
  );

  const recoverDeadSession = useCallback((): boolean => {
    // The ref starts false and is set true after the first 409 so a second
    // failure in this conversation does not remount again.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated across 409 recoveries
    if (recoveredRef.current.used || sessionRef.current === undefined) {
      return false;
    }
    recoveredRef.current.used = true;
    recoveringRef.current = true;
    pendingResendRef.current = lastSubmittedRef.current;
    persist({ eveSessionId: null, streamIndex: 0 })
      .then(() => {
        if (!isPaneAlive(aliveRef)) {
          return;
        }
        setRecoveryCount((count) => count + 1);
        toast.info(expiredSessionRestoredMessage);
      })
      .catch((error: unknown) => {
        if (!isPaneAlive(aliveRef)) {
          return;
        }
        recoveringRef.current = false;
        recoveredRef.current.used = false;
        pendingResendRef.current = null;
        if (lastSubmittedRef.current !== null) {
          setText(lastSubmittedRef.current);
        }
        if (isMissingRowError(error)) {
          return;
        }
        showError(formatChatSaveError(error));
      });
    return true;
  }, [persist, setText, showError]);

  const downCopy =
    agentLoad.kind === "down" ? agentLoad.message : agentDownMessage();
  const initialSession =
    recoveryCount === 0 ? sessionFromRow(conversation) : undefined;

  return (
    <ChatTurnSession
      agentToken={agentToken}
      aliveRef={aliveRef}
      contextLengthRef={contextLengthRef}
      downCopy={downCopy}
      focusSeq={focusSeq}
      idRef={idRef}
      initialEvents={eventsRef.current}
      initialSession={initialSession}
      key={recoveryCount}
      lastSubmittedRef={lastSubmittedRef}
      pendingActionRef={pendingActionRef}
      pendingResendRef={pendingResendRef}
      persist={persist}
      persistLater={persistLater}
      recoverDeadSession={recoverDeadSession}
      recoveringRef={recoveringRef}
      selectedModelRef={selectedModelRef}
      sessionRef={sessionRef}
      setText={setText}
      thinkingEnabledRef={thinkingEnabledRef}
    />
  );
}

function ChatTurnSession({
  agentToken,
  aliveRef,
  contextLengthRef,
  downCopy,
  focusSeq,
  idRef,
  initialEvents,
  initialSession,
  lastSubmittedRef,
  pendingActionRef,
  pendingResendRef,
  persist,
  persistLater,
  recoverDeadSession,
  recoveringRef,
  selectedModelRef,
  sessionRef,
  setText,
  thinkingEnabledRef,
}: {
  aliveRef: MutableRefObject<boolean>;
  contextLengthRef: MutableRefObject<number>;
  downCopy: string;
  focusSeq?: number;
  idRef: MutableRefObject<number | null>;
  initialEvents: EveAgentReducerEvent[];
  initialSession: ClientSessionState | undefined;
  lastSubmittedRef: MutableRefObject<string | null>;
  pendingActionRef: MutableRefObject<"send" | null>;
  pendingResendRef: MutableRefObject<string | null>;
  persist: (next: PersistPatch) => Promise<void>;
  persistLater: (next: PersistPatch) => void;
  recoverDeadSession: () => boolean;
  recoveringRef: MutableRefObject<boolean>;
  selectedModelRef: MutableRefObject<string>;
  sessionRef: MutableRefObject<ClientSessionState | undefined>;
  setText: (text: string) => void;
  thinkingEnabledRef: MutableRefObject<boolean>;
  agentToken: string | null;
}) {
  const agentTokenRef = useRef(agentToken);
  agentTokenRef.current = agentToken;
  const {
    actions: { clearError, lockContextLength, showError },
    state: { agent: chatAgent, models },
  } = useChat();
  const {
    state: { running: dreaming },
  } = useDream();
  const {
    state: { text },
  } = useChatDraft();
  // Capture once. Later saves replace eventsRef with the new session, and
  // clientContext lasts only for the current turn, so later sends in this
  // remount still need the old transcript.
  const [historyContext] = useState(() =>
    initialSession === undefined
      ? historyClientContext(initialEvents)
      : undefined
  );
  // One reducer per mounted session: it suffixes reused turn ids so a
  // recovered session's turns never overwrite the restored history.
  const [messageReducer] = useState(() => sessionNamespacingReducer());

  const handleAgentError = useCallback(
    (error: unknown) => {
      if (!isPaneAlive(aliveRef)) {
        return;
      }
      const action = pendingActionRef.current;
      if (
        isSessionNotActiveError(error) &&
        action !== null &&
        recoverDeadSession()
      ) {
        return;
      }
      if (action === "send" && lastSubmittedRef.current) {
        setText(lastSubmittedRef.current);
      }
      showError(formatChatSendError(error, downCopy));
    },
    [
      aliveRef,
      downCopy,
      lastSubmittedRef,
      pendingActionRef,
      recoverDeadSession,
      setText,
      showError,
    ]
  );

  const agent = useEveAgent({
    headers: (): Record<string, string> => {
      const headers: Record<string, string> = {
        "x-sage-context-length": String(contextLengthRef.current),
        "x-sage-think": thinkingEnabledRef.current ? "1" : "0",
      };
      const model = normalizeChatModelId(selectedModelRef.current);
      if (model.length > 0) {
        headers["x-sage-model"] = model;
      }
      return withChatAuthorization(headers, agentTokenRef.current);
    },
    host: eveHost(),
    initialEvents: initialEvents as MessageStreamEvent[],
    initialSession,
    onError: (error) => {
      handleAgentError(error);
    },
    onFinish: (snapshot) => {
      persistLater({
        events: [...snapshot.events],
        eveSessionId: recoveringRef.current
          ? null
          : (snapshot.session?.sessionId ?? null),
        streamIndex: recoveringRef.current
          ? 0
          : (snapshot.session?.streamIndex ?? 0),
      });
    },
    onSessionChange: (session) => {
      if (recoveringRef.current) {
        return;
      }
      if (sameSession(sessionRef.current, session)) {
        return;
      }
      persistLater({
        eveSessionId: session?.sessionId ?? null,
        streamIndex: session?.streamIndex ?? 0,
      });
    },
    prepareSend:
      historyContext === undefined
        ? undefined
        : (input) =>
            input.clientContext === undefined
              ? { ...input, clientContext: historyContext }
              : input,
    reducer: messageReducer,
    resume: initialSession !== undefined,
  });

  const handleAgentErrorRef = useRef(handleAgentError);
  handleAgentErrorRef.current = handleAgentError;
  const sendTurn = agent.send;

  useEffect(() => {
    recoveringRef.current = false;
    const next = pendingResendRef.current;
    if (next === null) {
      return;
    }
    // Fire the resend on a timer, not in the effect body. In dev, StrictMode
    // runs mount effects, then their cleanups (which detach the store and abort
    // any in-flight turn), then the effects again. A send started in the effect
    // body is aborted by that cleanup and fails silently — the message never
    // reaches the server. The first pass only schedules; its cleanup clears the
    // timer; the second pass schedules the send that actually runs.
    const timer = window.setTimeout(() => {
      if (pendingResendRef.current !== next) {
        return;
      }
      pendingResendRef.current = null;
      pendingActionRef.current = "send";
      lastSubmittedRef.current = next;
      const send = async () => {
        await sendTurn(next);
      };
      send().catch((error: unknown) => {
        handleAgentErrorRef.current(error);
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    lastSubmittedRef,
    pendingActionRef,
    pendingResendRef,
    recoveringRef,
    sendTurn,
  ]);

  const busy = agent.status === "submitted" || agent.status === "streaming";
  // eve reports "resuming" while a reattached session catches up; submission
  // would fail against the open resume stream, so block it until ready.
  const resuming = agent.status === "resuming";
  const submitStatus: ChatStatus = resuming ? "submitted" : agent.status;

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const next = message.text.trim();
      if (
        next.length === 0 ||
        agentTokenRef.current === null ||
        busy ||
        resuming ||
        isChatComposerLocked({ agent: chatAgent, dreaming, models })
      ) {
        return;
      }
      lockContextLength();
      clearError();
      lastSubmittedRef.current = next;
      pendingActionRef.current = "send";
      setText("");
      const send = async () => {
        if (idRef.current === null) {
          await persist({ events: [], title: clipTitle(next) });
        }
        await agent.send(next);
      };
      send().catch((error: unknown) => {
        handleAgentError(error);
      });
    },
    [
      agent,
      busy,
      chatAgent,
      clearError,
      dreaming,
      handleAgentError,
      idRef,
      lastSubmittedRef,
      lockContextLength,
      models,
      pendingActionRef,
      persist,
      resuming,
      setText,
    ]
  );

  const stopTurn = useCallback(() => {
    agent.cancel().catch(() => undefined);
  }, [agent]);

  const hasMessages = agent.data.messages.length > 0;

  return (
    <ChatPane>
      <ChatTranscriptShell
        contentClassName={hasMessages ? "py-6" : "h-full"}
        initial={focusSeq === undefined ? "instant" : false}
        resize={focusSeq === undefined ? "smooth" : false}
      >
        {hasMessages ? (
          <div className="flex flex-col gap-6">
            {agent.data.messages.map((item) => (
              <MessageBubble key={item.id} message={item} />
            ))}
            {shouldShowAssistantPending(agent.data.messages, agent.status) ? (
              <AssistantPending />
            ) : null}
            <SearchMessageFocus
              events={initialEvents}
              focusSeq={focusSeq}
              messages={agent.data.messages}
            />
          </div>
        ) : (
          <ConversationEmptyState
            className="[&_p]:mx-auto [&_p]:max-w-md"
            description="Talk through your thoughts with a companion that knows what you've written. Nothing you share leaves this space."
            icon={<MessageCircleIcon className="size-8" />}
            title="Chat with Sage"
          />
        )}
      </ChatTranscriptShell>
      <ChatComposerBar>
        <ChatPromptForm
          onStop={stopTurn}
          onSubmit={handleSubmit}
          submitDisabled={
            agentToken === null ||
            resuming ||
            (!busy && text.trim().length === 0)
          }
          submitStatus={submitStatus}
        />
      </ChatComposerBar>
    </ChatPane>
  );
}

function ChatSessionFallback() {
  return (
    <ChatPane aria-busy="true" aria-label="Loading conversation">
      <ChatTranscriptShell contentClassName="py-6">
        <ConversationSkeleton />
      </ChatTranscriptShell>
      <ChatComposerBar>
        <ChatPromptForm
          onSubmit={ignoreSubmit}
          submitDisabled
          submitStatus="ready"
        />
      </ChatComposerBar>
    </ChatPane>
  );
}

function ChatLoadFailed({ message }: { message: string }) {
  return (
    <ChatPane>
      <ChatTranscriptShell contentClassName="h-full">
        <ConversationEmptyState
          description={message}
          title="Could not open that chat"
        />
      </ChatTranscriptShell>
      <ChatComposerBar>
        <ChatPromptForm
          onSubmit={ignoreSubmit}
          submitDisabled
          submitStatus="ready"
        />
      </ChatComposerBar>
    </ChatPane>
  );
}

function ChatPane({ children, className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} {...props}>
      {children}
    </div>
  );
}

const searchFocusMs = 1600;

function SearchMessageFocus({
  events,
  focusSeq,
  messages,
}: {
  events: readonly EveAgentReducerEvent[];
  focusSeq?: number;
  messages: readonly EveMessage[];
}) {
  const { scrollToBottom, stopScroll } = useStickToBottomContext();
  const targetId =
    focusSeq === undefined ? null : projectedMessageIdAtSeq(events, focusSeq);
  const hasTarget =
    targetId !== null && messages.some((message) => message.id === targetId);

  useLayoutEffect(() => {
    if (focusSeq === undefined) {
      return;
    }
    if (targetId === null) {
      scrollToBottom("instant");
      return;
    }
    if (!hasTarget) {
      return;
    }
    const node = document.querySelector(
      `[data-message-id="${CSS.escape(targetId)}"]`
    );
    if (!(node instanceof HTMLElement)) {
      scrollToBottom("instant");
      return;
    }
    node.scrollIntoView({ block: "center" });
    node.dataset.searchFocus = "";
    stopScroll();
    const frame = window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => {
      delete node.dataset.searchFocus;
    }, searchFocusMs);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      delete node.dataset.searchFocus;
    };
  }, [focusSeq, hasTarget, scrollToBottom, stopScroll, targetId]);

  return null;
}

function ChatTranscriptShell({
  children,
  contentClassName,
  initial = "instant",
  resize = "smooth",
}: {
  children: ReactNode;
  contentClassName?: string;
  initial?: ComponentProps<typeof Conversation>["initial"];
  resize?: ComponentProps<typeof Conversation>["resize"] | false;
}) {
  return (
    <Conversation
      className={cn(
        "min-h-0 w-full",
        TRANSCRIPT_GUTTER_CLASS,
        TRANSCRIPT_FADE_CLASS
      )}
      initial={initial}
      resize={resize as ComponentProps<typeof Conversation>["resize"]}
    >
      <ConversationContent
        className={cn(TRANSCRIPT_COLUMN_CLASS, "gap-0 p-0", contentClassName)}
      >
        {children}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function ChatComposerBar({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        TRANSCRIPT_GUTTER_CLASS,
        "shrink-0 bg-background/80 pt-3 pb-5 backdrop-blur"
      )}
    >
      <div className={cn(TRANSCRIPT_COLUMN_CLASS, "flex flex-col gap-2")}>
        <ChatErrorAlert />
        <ChatAgentAlert />
        <ChatOllamaAlert />
        {children}
      </div>
    </div>
  );
}

function ChatPromptForm({
  onStop,
  onSubmit,
  submitDisabled,
  submitStatus,
}: {
  onStop?: () => void;
  onSubmit: (message: PromptInputMessage) => void;
  submitDisabled: boolean;
  submitStatus: ChatStatus;
}) {
  const {
    actions: { setText },
    state: { text },
  } = useChatDraft();
  const { state } = useChat();
  const {
    state: { running: dreaming },
  } = useDream();
  const locked = isChatComposerLocked({ ...state, dreaming });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onPromptChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setText(event.currentTarget.value);
    },
    [setText]
  );
  useLayoutEffect(() => {
    if (text.length === 0) {
      textareaRef.current?.scrollTo(0, 0);
    }
  }, [text]);
  return (
    <PromptInput className="w-full" onSubmit={onSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          className="shrink-0"
          disabled={locked}
          onChange={onPromptChange}
          placeholder={
            dreaming
              ? "Sage is dreaming… chat pauses until it finishes."
              : "What's on your mind?"
          }
          ref={textareaRef}
          value={text}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <ModelPicker />
        </PromptInputTools>
        <PromptInputSubmit
          disabled={locked || submitDisabled}
          onStop={onStop}
          status={submitStatus}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

function ConversationSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <UserMessageSkeleton />
      <AssistantMessageSkeleton>
        <AssistantRowSkeleton className="w-24" />
        <AssistantRowSkeleton className="w-36" />
        <AssistantProseSkeleton>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/5" />
        </AssistantProseSkeleton>
      </AssistantMessageSkeleton>
      <UserMessageSkeleton />
      <AssistantMessageSkeleton>
        <AssistantProseSkeleton>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </AssistantProseSkeleton>
      </AssistantMessageSkeleton>
    </div>
  );
}

function UserMessageSkeleton() {
  return (
    <div
      className="min-h-10 w-full rounded-2xl border border-input bg-surface"
      data-role="user"
    />
  );
}

function AssistantMessageSkeleton({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full justify-start" data-role="assistant">
      <div className="flex w-full flex-col gap-1">{children}</div>
    </div>
  );
}

function AssistantRowSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-8 items-center", ASSISTANT_PROSE_INSET)}>
      <Skeleton className={cn("h-3.5", className)} />
    </div>
  );
}

function AssistantProseSkeleton({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        ASSISTANT_PROSE_INSET,
        ASSISTANT_PROSE_SPACING
      )}
    >
      {children}
    </div>
  );
}

function ignoreSubmit(_message: PromptInputMessage) {
  // Pending and failed panes keep the composer visible but cannot send.
}

function isPaneAlive(aliveRef: MutableRefObject<boolean>): boolean {
  return aliveRef.current;
}

function sameSession(
  left: ClientSessionState | undefined,
  right: ClientSessionState | undefined
): boolean {
  return (
    (left?.sessionId ?? null) === (right?.sessionId ?? null) &&
    (left?.streamIndex ?? 0) === (right?.streamIndex ?? 0)
  );
}

async function applyPersistPatch(
  next: PersistPatch,
  refs: {
    aliveRef: MutableRefObject<boolean>;
    contextLengthRef: MutableRefObject<number>;
    eventsRef: MutableRefObject<EveAgentReducerEvent[]>;
    idRef: MutableRefObject<number | null>;
    persistedEventsRef: MutableRefObject<EveAgentReducerEvent[]>;
    recordCreated: (id: number, title: string) => void;
    refreshList: () => Promise<void>;
    selectedModelRef: MutableRefObject<string>;
    sessionRef: MutableRefObject<ClientSessionState | undefined>;
    thinkingEnabledRef: MutableRefObject<boolean>;
    titleRef: MutableRefObject<string>;
  }
): Promise<void> {
  if (!isPaneAlive(refs.aliveRef)) {
    return;
  }
  const previousTitle = refs.titleRef.current;
  const previousEvents = refs.persistedEventsRef.current;
  const previousSession = refs.sessionRef.current;
  if (next.title !== undefined) {
    refs.titleRef.current = next.title;
  }
  if (next.events !== undefined) {
    refs.eventsRef.current = next.events;
  }
  refs.sessionRef.current = mergeSession(refs.sessionRef.current, next);
  const session = refs.sessionRef.current;
  const created = refs.idRef.current === null;
  const nextEvents = refs.eventsRef.current;
  const baseSeq = commonPrefixLength(previousEvents, nextEvents);
  if (
    isUnchangedSave({
      baseSeq,
      created,
      nextEvents,
      previousEvents,
      previousSession,
      previousTitle,
      session,
      title: refs.titleRef.current,
    })
  ) {
    return;
  }
  try {
    const id = await chatSave({
      baseSeq,
      contextLength: refs.contextLengthRef.current,
      events: JSON.stringify(nextEvents.slice(baseSeq)),
      eveSessionId: session?.sessionId ?? null,
      id: refs.idRef.current,
      model: normalizeChatModelId(refs.selectedModelRef.current),
      streamIndex: session?.streamIndex ?? 0,
      thinking: refs.thinkingEnabledRef.current,
      title: refs.titleRef.current || "New chat",
    });
    if (!isPaneAlive(refs.aliveRef)) {
      return;
    }
    refs.idRef.current = id;
    refs.persistedEventsRef.current = nextEvents;
    if (created) {
      refs.recordCreated(id, refs.titleRef.current || "New chat");
    }
    await refs.refreshList();
  } catch (error) {
    if (!isPaneAlive(refs.aliveRef) || isMissingRowError(error)) {
      return;
    }
    throw error;
  }
}

function isUnchangedSave({
  baseSeq,
  created,
  nextEvents,
  previousEvents,
  previousSession,
  previousTitle,
  session,
  title,
}: {
  baseSeq: number;
  created: boolean;
  nextEvents: readonly unknown[];
  previousEvents: readonly unknown[];
  previousSession: ClientSessionState | undefined;
  previousTitle: string;
  session: ClientSessionState | undefined;
  title: string;
}): boolean {
  if (
    created ||
    title !== previousTitle ||
    !sameSession(previousSession, session)
  ) {
    return false;
  }
  if (previousEvents.length !== nextEvents.length) {
    return false;
  }
  return baseSeq === nextEvents.length;
}

function sessionFromRow(
  conversation: ChatConversation | null
): ClientSessionState | undefined {
  if (conversation?.eveSessionId) {
    return {
      sessionId: conversation.eveSessionId,
      streamIndex: conversation.streamIndex,
    };
  }
  return undefined;
}

function clipTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= titleLimit) {
    return trimmed;
  }
  return `${trimmed.slice(0, titleLimit - 1)}…`;
}
