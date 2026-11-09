import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  type DictationStatus,
  type DictationStoppedEvent,
  type DictationTextEvent,
  dictationErrorCode,
  downloadSpeechModel,
  getDictationStatus,
  hasNativeBridge,
  onDictationStarted,
  onDictationStopped,
  onDictationText,
  openDictationSettings,
  startDictation,
  stopDictation,
  waitForNativeBridge,
} from "@/bridge";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import {
  type DictationAction,
  type DictationOwner,
  type DictationPhase,
  type DictationSessionState,
  type DictationStopReason,
  deniedMessage,
  idleSession,
  isCurrentSession,
  isDictating,
  lostWordsMessage,
  modelDownloadingMessage,
  modelFailedMessage,
  modelReadyMessage,
  reduceDictation,
  type StopNotice,
  speechModelPercent,
  startFailure,
  startFailureMessages,
  stopNotice,
  textVerdict,
} from "@/lib/dictation-session";
import { isInEditor, isStopKey } from "@/lib/dictation-shortcut";
import { hasOpenSurface } from "@/lib/open-surface";

/**
 * Where dictated words go. The owner that is dictating registers one: the open
 * entry's editor, or the Chat message box.
 */
export interface DictationSink {
  /**
   * The session is over, for any reason. Grey words that are left are the
   * owner's to settle or drop. `discarded` is the person leaving.
   */
  onStopped: (reason: DictationStopReason) => void;
  /** Words from the core: what settled, and the whole grey tail now. */
  onText: (final: string, volatile: string) => void;
  /** Called as dictation starts. False means there is nothing to type into. */
  prepare: () => boolean;
}

interface DictationState {
  /** This Mac can dictate, so the mic shows. */
  available: boolean;
  owner: DictationOwner | null;
  phase: DictationPhase;
}

interface DictationActions {
  /** Starts the speech model download. `announce` also says so in a toast. */
  downloadModel: (options: { announce: boolean }) => Promise<void>;
  /**
   * The person is leaving this owner: the entry, or the chat. Ends its session
   * at once and tells its sink to settle. True when a session was running.
   */
  leave: (owner: DictationOwner) => boolean;
  refreshStatus: () => Promise<DictationStatus>;
  registerSink: (owner: DictationOwner, sink: DictationSink) => () => void;
  start: (owner: DictationOwner) => Promise<void>;
  /** Stops listening. The core finishes the words it already heard. */
  stop: () => void;
  toggle: (owner: DictationOwner) => Promise<void>;
}

interface DictationContextValue {
  actions: DictationActions;
  meta: Record<string, never>;
  state: DictationState;
}

interface SpeechModelValue {
  actions: Pick<DictationActions, "downloadModel" | "refreshStatus">;
  status: DictationStatus | null;
}

const emptyMeta = {};

// A flag in a ref that an async function sets before an `await` and reads
// after it. Reading it through a function keeps a lint rule from deciding that
// the value cannot have changed.
function readFlag(flag: RefObject<boolean>): boolean {
  return flag.current;
}

function takeFlag(flag: RefObject<boolean>): boolean {
  const { current } = flag;
  flag.current = false;
  return current;
}
const toastIds = {
  error: "dictation-error",
  gap: "dictation-gap",
  mic: "dictation-mic",
  model: "dictation-model",
} as const;
const modelPollMs = 1000;
const reconcilePollMs = 3000;

const DictationContext = createContext<DictationContextValue | null>(null);
const DictationActionsContext = createContext<DictationActions | null>(null);
const DictationTailContext = createContext<string>("");
const SpeechModelContext = createContext<SpeechModelValue | null>(null);

export function useDictation(): DictationContextValue {
  const value = use(DictationContext);
  if (!value) {
    throw new Error("DictationProvider is missing.");
  }
  return value;
}

/** Only the actions. They never change, so a part that only acts never redraws. */
export function useDictationActions(): DictationActions {
  const value = use(DictationActionsContext);
  if (!value) {
    throw new Error("DictationProvider is missing.");
  }
  return value;
}

/** The grey words for the Chat message box. Changes about once a second. */
export function useDictationTail(): string {
  return use(DictationTailContext);
}

/** The speech model's state, for Settings > Models. */
export function useSpeechModel(): SpeechModelValue {
  const value = use(SpeechModelContext);
  if (!value) {
    throw new Error("DictationProvider is missing.");
  }
  return value;
}

function showDenied() {
  toast.error(deniedMessage, {
    action: {
      label: "Open System Settings",
      onClick: () => {
        openDictationSettings().catch(() => undefined);
      },
    },
    id: toastIds.mic,
  });
}

function showStopNotice(notice: StopNotice) {
  if (notice.kind === "denied") {
    showDenied();
    return;
  }
  toast.error(notice.message, { id: toastIds.error });
}

/**
 * Holds the one dictation that can run at a time: whose it is, what phase it
 * is in, and the core's messages. It sits inside the lock and above the
 * journal, so locking unmounts it. The words go to the owner's sink. The
 * editor's grey tail is drawn by the editor itself. Chat's lives here, because
 * the message box and the mic button are in different places.
 */
export function DictationProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<DictationSessionState>(idleSession);
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [tail, setTail] = useState("");
  const [watchingModel, setWatchingModel] = useState(false);

  // Messages from the core arrive outside render, so they read the session
  // from a ref that every change updates first.
  const sessionRef = useRef(idleSession);
  const sinksRef = useRef<Partial<Record<DictationOwner, DictationSink>>>({});
  // Each start has a number. One that is no longer the latest was left.
  const startRef = useRef(0);
  // A stop asked for before the core had given the session an id.
  const stopAfterStartRef = useRef(false);
  const announceModelRef = useRef(false);
  // Polls in a row that found no session for the one this page has.
  const missesRef = useRef(0);

  const apply = useCallback((action: DictationAction) => {
    const next = reduceDictation(sessionRef.current, action);
    if (next !== sessionRef.current) {
      sessionRef.current = next;
      setSession(next);
    }
    return next;
  }, []);

  const refreshStatus = useCallback(async () => {
    const next = await getDictationStatus();
    setStatus(next);
    setAvailable(next.available);
    return next;
  }, []);

  // Read what this Mac can do before showing the mic. A session left running
  // by a reload of the page would keep the mic busy, so it ends.
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (!((await waitForNativeBridge()) && hasNativeBridge())) {
        return;
      }
      try {
        const next = await refreshStatus();
        if (cancelled) {
          return;
        }
        if (next.session !== null && sessionRef.current.session === null) {
          await stopDictation(next.session, true);
        }
        if (next.model.state === "downloading") {
          setWatchingModel(true);
        }
      } catch {
        // Without a status the mic stays hidden.
      }
    };
    read().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  const finish = useCallback(
    (owner: DictationOwner | null, reason: DictationStopReason) => {
      if (owner === null) {
        return;
      }
      if (owner === "chat") {
        setTail("");
      }
      sinksRef.current[owner]?.onStopped(reason);
    },
    []
  );

  const stop = useCallback(() => {
    const state = sessionRef.current;
    if (!isDictating(state)) {
      return;
    }
    if (state.session === null) {
      stopAfterStartRef.current = true;
      return;
    }
    apply({ type: "stop" });
    stopDictation(state.session, false).catch(() => undefined);
  }, [apply]);

  const leave = useCallback(
    (owner: DictationOwner): boolean => {
      const state = sessionRef.current;
      if (state.phase === "idle" || state.owner !== owner) {
        return false;
      }
      startRef.current += 1;
      stopAfterStartRef.current = false;
      apply({ type: "left" });
      finish(owner, "discarded");
      if (state.session !== null) {
        stopDictation(state.session, true).catch(() => undefined);
      }
      return true;
    },
    [apply, finish]
  );

  const downloadModel = useCallback(
    async ({ announce }: { announce: boolean }) => {
      announceModelRef.current = announce;
      if (announce) {
        toast.loading(modelDownloadingMessage, {
          duration: Number.POSITIVE_INFINITY,
          id: toastIds.model,
        });
      }
      try {
        await downloadSpeechModel();
        setWatchingModel(true);
        await refreshStatus();
      } catch {
        setWatchingModel(false);
        toast.error(modelFailedMessage, { id: toastIds.model });
      }
    },
    [refreshStatus]
  );

  const reportStartFailure = useCallback(
    (error: unknown) => {
      const failure = startFailure(dictationErrorCode(error));
      if (failure === "denied") {
        showDenied();
      } else if (failure === "download") {
        downloadModel({ announce: true }).catch(() => undefined);
      } else if (failure === "unavailable") {
        setAvailable(false);
        toast.error(startFailureMessages.unavailable, { id: toastIds.error });
      } else if (failure !== "locked") {
        toast.error(startFailureMessages[failure], { id: toastIds.error });
      }
    },
    [downloadModel]
  );

  const start = useCallback(
    async (owner: DictationOwner) => {
      const { owner: running, phase } = sessionRef.current;
      if (phase !== "idle") {
        if (running === owner) {
          return;
        }
        // The other owner stops first. The core may take a moment to let go.
        if (running !== null) {
          leave(running);
        }
      }
      const sink = sinksRef.current[owner];
      if (sink === undefined || !sink.prepare()) {
        return;
      }
      startRef.current += 1;
      const mine = startRef.current;
      stopAfterStartRef.current = false;
      apply({ owner, type: "requested" });
      let started: number;
      try {
        started = await startDictation();
      } catch (error) {
        if (mine === startRef.current) {
          apply({ type: "failed" });
          sink.onStopped("discarded");
          reportStartFailure(error);
        }
        return;
      }
      if (mine !== startRef.current) {
        // The person left while the core was starting. Nobody is listening.
        stopDictation(started, true).catch(() => undefined);
        return;
      }
      apply({ session: started, type: "accepted" });
      if (takeFlag(stopAfterStartRef)) {
        stop();
      }
    },
    [apply, leave, reportStartFailure, stop]
  );

  const toggle = useCallback(
    async (owner: DictationOwner) => {
      if (sessionRef.current.phase === "idle") {
        await start(owner);
        return;
      }
      stop();
    },
    [start, stop]
  );

  const registerSink = useCallback(
    (owner: DictationOwner, sink: DictationSink) => {
      sinksRef.current[owner] = sink;
      return () => {
        if (sinksRef.current[owner] !== sink) {
          return;
        }
        // Whatever it typed into is going away.
        leave(owner);
        delete sinksRef.current[owner];
      };
    },
    [leave]
  );

  const handleText = useEffectEvent((event: DictationTextEvent) => {
    const before = sessionRef.current;
    if (textVerdict(before, event.session, event.seq) === "ignore") {
      return;
    }
    const next = apply({
      seq: event.seq,
      session: event.session,
      type: "text",
    });
    if (!before.lostWords && next.lostWords) {
      toast.warning(lostWordsMessage, { id: toastIds.gap });
    }
    if (next.owner === null) {
      return;
    }
    if (next.owner === "chat") {
      setTail(event.volatile);
    }
    sinksRef.current[next.owner]?.onText(event.final, event.volatile);
  });

  const handleStopped = useEffectEvent((event: DictationStoppedEvent) => {
    const before = sessionRef.current;
    if (!isCurrentSession(before, event.session)) {
      return;
    }
    apply({ session: event.session, type: "stopped" });
    finish(before.owner, event.reason);
    const notice = stopNotice(event.reason, event.message);
    if (notice !== null) {
      showStopNotice(notice);
    }
  });

  useEffect(() => {
    const offs = [
      onDictationStarted(({ session: id }) => {
        apply({ session: id, type: "started" });
      }),
      onDictationText((event) => handleText(event)),
      onDictationStopped((event) => handleStopped(event)),
    ];
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [apply]);

  // Esc stops the mic, unless a menu or dialog took it first.
  const dictating =
    session.phase === "starting" || session.phase === "listening";
  useEffect(() => {
    if (!dictating) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!isStopKey(event, isInEditor(event.target)) || hasOpenSurface()) {
        return;
      }
      event.preventDefault();
      stop();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dictating, stop]);

  // The core's messages can be lost, and a stop that never arrives would leave
  // the mic button stuck. While the mic is on, ask the core now and then
  // whether it still has the session. One miss is not enough, because the core
  // may be between stopping and sending its last words. Starting is left
  // alone, because the macOS microphone prompt can keep it waiting.
  useVisiblePoll(
    async () => {
      const mine = sessionRef.current;
      if (mine.session === null || mine.phase === "starting") {
        missesRef.current = 0;
        return;
      }
      const next = await getDictationStatus();
      const now = sessionRef.current;
      if (now.session !== mine.session) {
        return;
      }
      missesRef.current =
        next.session === mine.session ? 0 : missesRef.current + 1;
      if (missesRef.current < 2) {
        return;
      }
      missesRef.current = 0;
      apply({ session: mine.session, type: "stopped" });
      finish(mine.owner, "engine_failed");
    },
    reconcilePollMs,
    { enabled: session.phase !== "idle", leading: false }
  );

  // Watch a model download until it ends, then say so if this page started it.
  useVisiblePoll(
    async () => {
      const next = await refreshStatus();
      const { model } = next;
      if (model.state === "downloading") {
        if (readFlag(announceModelRef)) {
          const percent = speechModelPercent(model.fraction);
          toast.loading(
            percent === null
              ? modelDownloadingMessage
              : `${modelDownloadingMessage} ${percent}`,
            { duration: Number.POSITIVE_INFINITY, id: toastIds.model }
          );
        }
        return;
      }
      setWatchingModel(false);
      if (!takeFlag(announceModelRef)) {
        return;
      }
      if (model.state === "installed") {
        toast.success(modelReadyMessage, { id: toastIds.model });
      } else {
        toast.error(model.message ?? modelFailedMessage, {
          id: toastIds.model,
        });
      }
    },
    modelPollMs,
    { enabled: watchingModel, leading: false }
  );

  // Locking unmounts this provider. The core has already stopped by then, and
  // this makes sure of it.
  useEffect(
    () => () => {
      const { session: id } = sessionRef.current;
      if (id !== null) {
        stopDictation(id, true).catch(() => undefined);
      }
    },
    []
  );

  const actions = useMemo<DictationActions>(
    () => ({
      downloadModel,
      leave,
      refreshStatus,
      registerSink,
      start,
      stop,
      toggle,
    }),
    [downloadModel, leave, refreshStatus, registerSink, start, stop, toggle]
  );
  const value = useMemo<DictationContextValue>(
    () => ({
      actions,
      meta: emptyMeta,
      state: { available, owner: session.owner, phase: session.phase },
    }),
    [actions, available, session.owner, session.phase]
  );
  const modelValue = useMemo<SpeechModelValue>(
    () => ({
      actions: { downloadModel, refreshStatus },
      status,
    }),
    [downloadModel, refreshStatus, status]
  );

  return (
    <DictationActionsContext value={actions}>
      <DictationContext value={value}>
        <DictationTailContext value={tail}>
          <SpeechModelContext value={modelValue}>{children}</SpeechModelContext>
        </DictationTailContext>
      </DictationContext>
    </DictationActionsContext>
  );
}
