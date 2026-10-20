import type { ChatStatus } from "ai";
import type {
  ClientSessionState,
  EveAgentReducerEvent,
  MessageStreamEvent,
} from "eve/client";
import { type EveMessage, useEveAgent } from "eve/react";
import { ArrowDownIcon, MessageCircleIcon } from "lucide-react";
import { m } from "motion/react";
import {
  type ChangeEvent,
  type ComponentProps,
  Fragment,
  type ReactNode,
  type RefObject,
  Suspense,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { type ChatConversation, chatSave, isMissingRowError } from "@/bridge";
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
import {
  useChatDraft,
  useChatDraftActions,
} from "@/components/chat/chat-draft";
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
import {
  type ChatFocus,
  type ChatSelection,
  isChatComposerLocked,
  useChat,
} from "@/components/chat-provider";
import { useDream } from "@/components/dream-provider";
import { Hint } from "@/components/hint";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
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
  type ChatLoadPromise,
  loadConversation,
} from "@/lib/chat/load-conversation";
import {
  loadChatModelPrefs,
  normalizeChatModelId,
  prefsFromConversation,
} from "@/lib/chat/model-prefs";
import {
  historyClientContext,
  isEndedSessionError,
  projectedMessageIdAtSeq,
  sessionNamespacingReducer,
} from "@/lib/chat/session-recovery";
import { spring } from "@/lib/motion";
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
  while (
    i < n &&
    (left[i] === right[i] ||
      JSON.stringify(left[i]) === JSON.stringify(right[i]))
  ) {
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

/**
 * Loads a pane has already read. A running pane keeps its own copy of the
 * chat, so a load is out of date once its pane is gone: it has none of the
 * turns sent since. A pane that mounts on a used load reads the chat again.
 * Chat stays mounted while other screens show, so this happens only when the
 * whole app shell mounts again, such as after the protect reminder or setup,
 * and under StrictMode.
 */
const usedLoads = new WeakSet<ChatLoadPromise>();
// The read a mounting pane has started for a used load. Rendering twice, as
// StrictMode does, finds it instead of starting a second read. Once a pane
// has shown it, it counts as used, and the next mount reads again.
const rereads = new WeakMap<ChatLoadPromise, ChatLoadPromise>();

function loadForMount(selection: ChatSelection): {
  load: ChatLoadPromise;
  reread: boolean;
} {
  if (selection.kind !== "saved" || !usedLoads.has(selection.load)) {
    return { load: selection.load, reread: false };
  }
  const started = rereads.get(selection.load);
  if (started && !usedLoads.has(started)) {
    return { load: started, reread: true };
  }
  const fresh = loadConversation(selection.id);
  rereads.set(selection.load, fresh);
  return { load: fresh, reread: true };
}

/** The panel beside the chat list. */
export function ChatScreen() {
  const {
    state: { paneKey },
  } = useChat();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Fragment key={paneKey}>
        <ChatSessionLoad />
      </Fragment>
    </div>
  );
}

function ChatSessionLoad() {
  const {
    state: { selection },
  } = useChat();
  // Decided once, when the pane mounts, and above the Suspense boundary: a
  // component that suspends as it mounts loses its state and would decide
  // again. A new load from the provider, such as a chat that has just saved,
  // takes over from this one.
  const [mounted] = useState(() => ({
    ...loadForMount(selection),
    source: selection.load,
  }));
  const load =
    selection.load === mounted.source ? mounted.load : selection.load;
  useEffect(() => {
    usedLoads.add(load);
    usedLoads.add(selection.load);
  }, [load, selection.load]);
  // A search hit scrolls the chat to its message, whether it opens the chat or
  // finds it already open. A chat read again, as when the whole app shell
  // mounts again, opens at its end instead.
  const focus =
    selection.kind === "saved" && !mounted.reread ? selection.focus : undefined;
  return (
    <Suspense fallback={<ChatSessionFallback />}>
      <ChatSession focus={focus} load={load} />
    </Suspense>
  );
}

function ChatSession({
  focus,
  load,
}: {
  focus: ChatFocus | undefined;
  load: ChatLoadPromise;
}) {
  const {
    state: { agentToken },
  } = useChat();
  const result = use(load);
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
      focus={focus}
    />
  );
}

function ChatTurn({
  agentToken,
  conversation,
  focus,
}: {
  agentToken: string | null;
  conversation: ChatConversation | null;
  focus?: ChatFocus;
}) {
  const {
    actions: { applyConversationPrefs, recordCreated, refreshList, showError },
    state: { agent: agentLoad, contextLength, selectedModel, thinkingEnabled },
  } = useChat();
  const { setText } = useChatDraftActions();
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

  // The refs never change, so the object is built once and the turn gets the
  // same one on every render.
  const [turnRefs] = useState<TurnRefs>(() => ({
    aliveRef,
    contextLengthRef,
    idRef,
    lastSubmittedRef,
    pendingActionRef,
    pendingResendRef,
    recoveringRef,
    selectedModelRef,
    sessionRef,
    thinkingEnabledRef,
  }));

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
      downCopy={downCopy}
      focus={focus}
      initialEvents={eventsRef.current}
      initialSession={initialSession}
      key={recoveryCount}
      persist={persist}
      persistLater={persistLater}
      recoverDeadSession={recoverDeadSession}
      refs={turnRefs}
      setText={setText}
    />
  );
}

/** The refs a turn shares with its pane. Their identity never changes. */
interface TurnRefs {
  aliveRef: RefObject<boolean>;
  contextLengthRef: RefObject<number>;
  idRef: RefObject<number | null>;
  lastSubmittedRef: RefObject<string | null>;
  pendingActionRef: RefObject<"send" | null>;
  pendingResendRef: RefObject<string | null>;
  recoveringRef: RefObject<boolean>;
  selectedModelRef: RefObject<string>;
  sessionRef: RefObject<ClientSessionState | undefined>;
  thinkingEnabledRef: RefObject<boolean>;
}

function ChatTurnSession({
  agentToken,
  downCopy,
  focus,
  initialEvents,
  initialSession,
  persist,
  persistLater,
  recoverDeadSession,
  refs,
  setText,
}: {
  agentToken: string | null;
  downCopy: string;
  focus?: ChatFocus;
  initialEvents: EveAgentReducerEvent[];
  initialSession: ClientSessionState | undefined;
  persist: (next: PersistPatch) => Promise<void>;
  persistLater: (next: PersistPatch) => void;
  recoverDeadSession: () => boolean;
  refs: TurnRefs;
  setText: (text: string) => void;
}) {
  const {
    aliveRef,
    contextLengthRef,
    idRef,
    lastSubmittedRef,
    pendingActionRef,
    pendingResendRef,
    recoveringRef,
    selectedModelRef,
    sessionRef,
    thinkingEnabledRef,
  } = refs;
  const agentTokenRef = useRef(agentToken);
  agentTokenRef.current = agentToken;
  const {
    actions: { clearError, lockContextLength, showError },
    state: { agent: chatAgent, models },
  } = useChat();
  const {
    state: { running: dreaming },
  } = useDream();
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
      // A send, or the resume of a reopened chat, can learn that the session
      // no longer runs. eve reports a stranded session on resume, so recover
      // there too instead of showing an error.
      if (isEndedSessionError(error) && recoverDeadSession()) {
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
  // Messages already here when this pane opens do not animate, even if the
  // chat is still streaming. Only ones that arrive after do.
  const [openingMessageIds] = useState(
    () => new Set(agent.data.messages.map((item) => item.id))
  );
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

  const { messages } = agent.data;
  const pending = shouldShowAssistantPending(messages, agent.status);

  return (
    <ChatPane>
      {messages.length > 0 ? (
        <ChatTranscriptShell
          busy={busy}
          outside={
            <SearchMessageFocus
              events={initialEvents}
              focus={focus}
              messages={messages}
            />
          }
        >
          {messages.map((item, index) => (
            <MessageScrollerItem
              className={TRANSCRIPT_ITEM_CLASS}
              // eve shows a sent message under a temporary id, then swaps in
              // the server's. Keyed by id, the row would be replaced, and the
              // scroller jumps to the chat's first message when a row is
              // replaced. Messages only ever arrive at the end, so the
              // position is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              messageId={item.id}
              scrollAnchor={item.role === "user"}
            >
              <MessageArrival
                arriving={busy && !openingMessageIds.has(item.id)}
              >
                <MessageBubble message={item} />
              </MessageArrival>
              {pending && index === messages.length - 1 ? (
                <AssistantPending />
              ) : null}
            </MessageScrollerItem>
          ))}
        </ChatTranscriptShell>
      ) : (
        <ChatEmptyState
          description="Talk through your thoughts with a companion that knows what you've written. Nothing you share leaves this space."
          icon={<MessageCircleIcon />}
          title="Chat with Sage"
        />
      )}
      <ChatComposerBar>
        <ChatPromptForm
          onStop={stopTurn}
          onSubmit={handleSubmit}
          submitBlocked={agentToken === null || resuming}
          submitStatus={submitStatus}
        />
      </ChatComposerBar>
    </ChatPane>
  );
}

/**
 * A message that arrives during a turn rises into place. Messages that are
 * already there when a saved chat opens do not move. Only opacity and
 * position change, because a height change would fight the scroll to the
 * bottom.
 */
function MessageArrival({
  arriving,
  children,
}: {
  arriving: boolean;
  children: ReactNode;
}) {
  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className="empty:hidden"
      initial={arriving ? { opacity: 0, y: 16 } : false}
      transition={spring}
    >
      {children}
    </m.div>
  );
}

function ChatSessionFallback() {
  return (
    <ChatPane aria-busy="true" aria-label="Loading conversation">
      <ChatTranscriptShell>
        <MessageScrollerItem>
          <ConversationSkeleton />
        </MessageScrollerItem>
      </ChatTranscriptShell>
      <ChatComposerBar>
        <ChatPromptForm
          onSubmit={ignoreSubmit}
          submitBlocked
          submitStatus="ready"
        />
      </ChatComposerBar>
    </ChatPane>
  );
}

function ChatLoadFailed({ message }: { message: string }) {
  return (
    <ChatPane>
      <ChatEmptyState description={message} title="Could not open that chat" />
      <ChatComposerBar>
        <ChatPromptForm
          onSubmit={ignoreSubmit}
          submitBlocked
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
  focus,
  messages,
}: {
  events: readonly EveAgentReducerEvent[];
  focus?: ChatFocus;
  messages: readonly EveMessage[];
}) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const targetId =
    focus === undefined ? null : projectedMessageIdAtSeq(events, focus.seq);
  const hasTarget =
    targetId !== null && messages.some((message) => message.id === targetId);

  // Runs after the scroller has opened the chat at its end, so the search
  // hit wins.
  useLayoutEffect(() => {
    if (focus === undefined) {
      return;
    }
    if (targetId === null) {
      scrollToEnd();
      return;
    }
    if (!hasTarget) {
      return;
    }
    // The row carries the id too, so ask for the bubble inside it, which has
    // the ring.
    const node = document.querySelector(
      `[data-slot="message-scroller-item"] [data-message-id="${CSS.escape(targetId)}"]`
    );
    if (!(node instanceof HTMLElement)) {
      scrollToEnd();
      return;
    }
    node.dataset.searchFocus = "";
    scrollToMessage(targetId, { align: "center" });
    // Rows near the target draw at their real height only once they are on
    // screen, so center it again on the next frame.
    const frame = window.requestAnimationFrame(() => {
      scrollToMessage(targetId, { align: "center" });
    });
    const timer = window.setTimeout(() => {
      delete node.dataset.searchFocus;
    }, searchFocusMs);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      delete node.dataset.searchFocus;
    };
  }, [focus, hasTarget, scrollToEnd, scrollToMessage, targetId]);

  return null;
}

/**
 * A transcript row. The pending leaf sits inside the last row rather than in a
 * row of its own: the scroller anchors a sent message when rows are added, and
 * swapping one row for another in the same render would make it jump to the
 * chat's first message. A row whose message shows nothing takes no space, and
 * a row with a search hit draws past its edge so the ring shows.
 */
const TRANSCRIPT_ITEM_CLASS =
  "flex flex-col gap-6 has-[>:only-child:empty]:hidden has-[[data-search-focus]]:[content-visibility:visible]";

/**
 * The scrolling transcript. Sending a message moves it near the top, and the
 * reply follows below it until it fills the view.
 */
function ChatTranscriptShell({
  busy = false,
  children,
  outside,
}: {
  /** True while a reply streams, so a screen reader reads it once when done. */
  busy?: boolean;
  children: ReactNode;
  /** Parts that use the scroller but are not transcript rows. */
  outside?: ReactNode;
}) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller
        className={cn(
          "min-h-0 flex-1",
          TRANSCRIPT_GUTTER_CLASS,
          TRANSCRIPT_FADE_CLASS
        )}
      >
        <MessageScrollerViewport className="hide-scrollbar scroll-fade-none scrollbar-none">
          <MessageScrollerContent
            aria-busy={busy}
            className={cn(TRANSCRIPT_COLUMN_CLASS, "py-6")}
          >
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Hint label="Scroll to latest">
          <MessageScrollerButton
            aria-label="Scroll to latest message"
            className="rounded-full bg-surface hover:bg-accent dark:hover:bg-muted"
            size="icon"
            variant="outline"
          >
            <ArrowDownIcon />
          </MessageScrollerButton>
        </Hint>
      </MessageScroller>
      {outside}
    </MessageScrollerProvider>
  );
}

function ChatEmptyState({
  description,
  icon,
  title,
}: {
  description: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <Empty className={cn("min-h-0", TRANSCRIPT_GUTTER_CLASS)}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ChatComposerBar({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        TRANSCRIPT_GUTTER_CLASS,
        "shrink-0 bg-background/80 pt-3 pb-5 backdrop-blur"
      )}
      data-slot="chat-composer-bar"
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
  submitBlocked,
  submitStatus,
}: {
  onStop?: () => void;
  onSubmit: (message: PromptInputMessage) => void;
  /** Sending is not possible yet, whatever the box holds. */
  submitBlocked: boolean;
  submitStatus: ChatStatus;
}) {
  const { state } = useChat();
  const {
    state: { running: dreaming },
  } = useDream();
  const locked = isChatComposerLocked({ ...state, dreaming });
  // The form never reads the text. Only the two leaves below do, so a
  // keystroke redraws them and not the model picker or the rest of the form.
  return (
    <PromptInput className="w-full" onSubmit={onSubmit}>
      <PromptInputBody className="relative w-full">
        <ChatPromptTextarea dreaming={dreaming} locked={locked} />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <ModelPicker />
        </PromptInputTools>
        <ChatPromptSubmit
          blocked={locked || submitBlocked}
          onStop={onStop}
          status={submitStatus}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

function ChatPromptTextarea({
  dreaming,
  locked,
}: {
  dreaming: boolean;
  locked: boolean;
}) {
  const {
    actions: { setText },
    state: { text },
  } = useChatDraft();
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
  const placeholder = dreaming
    ? "Sage is dreaming… chat pauses until it finishes."
    : "What's on your mind?";
  // The placeholder is drawn here, not by the textarea. WebKit sizes a native
  // placeholder in a field-sizing textarea once and can keep a narrow width
  // after the box empties, cutting the text off until something restyles it.
  return (
    <>
      <PromptInputTextarea
        aria-label="Message"
        aria-placeholder={placeholder}
        className="shrink-0"
        disabled={locked}
        onChange={onPromptChange}
        placeholder=""
        ref={textareaRef}
        value={text}
      />
      {text.length === 0 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 px-5 pt-4 text-muted-foreground text-sm"
        >
          {placeholder}
        </span>
      ) : null}
    </>
  );
}

function ChatPromptSubmit({
  blocked,
  onStop,
  status,
}: {
  blocked: boolean;
  onStop?: () => void;
  status: ChatStatus;
}) {
  const {
    state: { text },
  } = useChatDraft();
  // While a reply is on its way the button stops it, so it needs no text.
  const busy = status === "submitted" || status === "streaming";
  return (
    <PromptInputSubmit
      disabled={blocked || (!busy && text.trim().length === 0)}
      onStop={onStop}
      status={status}
    />
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

function isPaneAlive(aliveRef: RefObject<boolean>): boolean {
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
  refs: Pick<
    TurnRefs,
    | "aliveRef"
    | "contextLengthRef"
    | "idRef"
    | "selectedModelRef"
    | "sessionRef"
    | "thinkingEnabledRef"
  > & {
    eventsRef: RefObject<EveAgentReducerEvent[]>;
    persistedEventsRef: RefObject<EveAgentReducerEvent[]>;
    recordCreated: (id: number, title: string) => void;
    refreshList: () => Promise<void>;
    titleRef: RefObject<string>;
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
