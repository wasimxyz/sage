import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  cancelOllamaPull,
  getOllamaPull,
  getOllamaStatus,
  getOnboardingStatus,
  type OllamaPullProgress,
  pullOllamaModel,
  saveOnboarding,
} from "@/bridge";
import { enqueueModels, nextQueueStep } from "@/lib/model-queue";

const pollMs = 1000;
// Ollama is not running, so a model cannot start. Look again in a moment.
const waitForOllamaMs = 4000;

interface ModelDownloadsState {
  /** Downloads that finished since launch, so a table can reload its list. */
  completed: number;
  /** The saved queue has been read. */
  loaded: boolean;
  /** Why a queued model did not finish, by model, until it is tried again. */
  problems: Readonly<Record<string, string>>;
  /** The core's latest download, or null if none has run since launch. */
  pull: OllamaPullProgress | null;
  /** Models still to download, in order. The first is downloading or next. */
  queue: readonly string[];
}

interface ModelDownloadsActions {
  cancel: () => Promise<void>;
  /** Add models to the queue and try again any that failed before. */
  enqueue: (models: readonly string[]) => void;
  /** Download one model now, outside the queue. Rejects if Sage cannot start it. */
  start: (tag: string) => Promise<void>;
}

interface ModelDownloadsContextValue {
  actions: ModelDownloadsActions;
  state: ModelDownloadsState;
}

const ModelDownloadsContext = createContext<ModelDownloadsContextValue | null>(
  null
);

export function useModelDownloads(): ModelDownloadsContextValue {
  const value = use(ModelDownloadsContext);
  if (!value) {
    throw new Error("ModelDownloadsProvider is missing.");
  }
  return value;
}

/**
 * Downloads the models setup asks for, one at a time, and reports every
 * download to Settings > Models too. It sits above setup and Home, so a
 * download keeps going after setup ends or is skipped. The queue is saved in
 * `app_setting`, so a restart, a refresh, or an unlock picks it up again until
 * each model is ready or cancelled.
 */
export function ModelDownloadsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<readonly string[]>([]);
  const [pull, setPull] = useState<OllamaPullProgress | null>(null);
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>(
    {}
  );
  const [completed, setCompleted] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // The poll loop and the actions run outside render, so they read the queue
  // and the two download names from refs.
  const queueRef = useRef<readonly string[]>([]);
  // The model this page started, so a download left over from before is not
  // mistaken for the queue's own.
  const startedRef = useRef<string | null>(null);
  // The model whose end this page reports once: one it started or saw running.
  const watchedRef = useRef<string | null>(null);

  const commitQueue = useCallback((next: readonly string[]) => {
    queueRef.current = next;
    setQueue(next);
    saveOnboarding({ downloads: [...next] }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getOnboardingStatus()
      .then((status) => {
        if (!cancelled) {
          queueRef.current = status.downloads;
          setQueue(status.downloads);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const observe = useCallback((next: OllamaPullProgress | null) => {
    if (next === null) {
      return;
    }
    if (next.active) {
      watchedRef.current = next.model;
      return;
    }
    if (watchedRef.current !== next.model) {
      return;
    }
    watchedRef.current = null;
    announceOutcome(next);
    if (next.done) {
      setCompleted((count) => count + 1);
    }
  }, []);

  const finishHead = useCallback(
    (model: string, outcome: "cancelled" | "done" | "failed") => {
      startedRef.current = null;
      commitQueue(queueRef.current.filter((name) => name !== model));
      if (outcome === "done") {
        setProblems((previous) => withoutKeys(previous, [model]));
        return;
      }
      const message =
        outcome === "cancelled" ? "Download cancelled." : "Download failed.";
      setProblems((previous) => ({ ...previous, [model]: message }));
    },
    [commitQueue]
  );

  const startHead = useCallback(
    async (model: string): Promise<number> => {
      // `ollama.pull` starts a background download and answers at once, even
      // with Ollama down. A start then would fail and drop the model from the
      // queue, so wait for Ollama instead.
      const status = await getOllamaStatus();
      if (!status.running) {
        return waitForOllamaMs;
      }
      startedRef.current = model;
      watchedRef.current = model;
      try {
        await pullOllamaModel(model);
        setPull(await getOllamaPull());
      } catch (error: unknown) {
        startedRef.current = null;
        watchedRef.current = null;
        // Someone started another download in the meantime. The head waits.
        if (!isDownloadInProgress(error)) {
          finishHead(model, "failed");
        }
      }
      return pollMs;
    },
    [finishHead]
  );

  const advanceQueue = useCallback(
    (current: OllamaPullProgress | null): Promise<number> | number => {
      const step = nextQueueStep({
        pull: current,
        queue: queueRef.current,
        started: startedRef.current,
      });
      switch (step.kind) {
        case "start":
          return startHead(step.model);
        case "watch":
          startedRef.current = step.model;
          return pollMs;
        case "finish":
          finishHead(step.model, step.outcome);
          return pollMs;
        default:
          return pollMs;
      }
    },
    [finishHead, startHead]
  );

  const busy = loaded && (queue.length > 0 || pull?.active === true);
  useEffect(() => {
    if (!busy) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      let delay = waitForOllamaMs;
      try {
        const next = await getOllamaPull();
        if (cancelled) {
          return;
        }
        setPull(next);
        observe(next);
        delay = await advanceQueue(next);
      } catch {
        // The bridge or Ollama did not answer. Try again in a moment.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          tick().catch(() => undefined);
        }, delay);
      }
    };
    tick().catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [advanceQueue, busy, observe]);

  const enqueue = useCallback(
    (models: readonly string[]) => {
      setProblems((previous) => withoutKeys(previous, models));
      commitQueue(enqueueModels(queueRef.current, models));
    },
    [commitQueue]
  );

  const start = useCallback(async (tag: string) => {
    watchedRef.current = tag;
    try {
      await pullOllamaModel(tag);
    } catch (error: unknown) {
      watchedRef.current = null;
      throw error;
    }
    setPull(await getOllamaPull());
  }, []);

  const cancel = useCallback(async () => {
    await cancelOllamaPull();
  }, []);

  const actions = useMemo<ModelDownloadsActions>(
    () => ({ cancel, enqueue, start }),
    [cancel, enqueue, start]
  );
  const value = useMemo<ModelDownloadsContextValue>(
    () => ({ actions, state: { completed, loaded, problems, pull, queue } }),
    [actions, completed, loaded, problems, pull, queue]
  );

  return (
    <ModelDownloadsContext value={value}>{children}</ModelDownloadsContext>
  );
}

function announceOutcome(pull: OllamaPullProgress) {
  if (pull.done) {
    toast.success(`Downloaded ${pull.model}.`);
    return;
  }
  if (pull.cancelled) {
    toast("Download cancelled.");
    return;
  }
  toast.error("Could not download the model.");
}

function isDownloadInProgress(error: unknown): boolean {
  return error instanceof Error && error.message.includes("DownloadInProgress");
}

function withoutKeys(
  record: Readonly<Record<string, string>>,
  keys: readonly string[]
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) {
      next[key] = value;
    }
  }
  return next;
}
