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
  getDreamStatus,
  getOllamaStatus,
  hasNativeBridge,
  onDreamFailed,
  onDreamFinished,
  onDreamProgress,
  onDreamStarted,
  startDream,
  waitForNativeBridge,
} from "@/bridge";
import { formatDreamError, ollamaDownDreamMessage } from "@/lib/dream-errors";

const ollamaPollMs = 4000;

interface DreamState {
  confirmOpen: boolean;
  done: number;
  lastDreamedAt: string | null;
  ollamaRunning: boolean;
  running: boolean;
  total: number;
}

interface DreamActions {
  dismiss: () => void;
  prompt: () => void;
  start: () => Promise<void>;
}

interface DreamContextValue {
  actions: DreamActions;
  meta: Record<string, never>;
  state: DreamState;
}

const DreamContext = createContext<DreamContextValue | null>(null);
const emptyMeta = {};

export function useDream(): DreamContextValue {
  const value = use(DreamContext);
  if (!value) {
    throw new Error("DreamProvider is missing.");
  }
  return value;
}

function finishMessage(
  facts: number,
  events: number,
  failures: number
): string {
  if (failures > 0) {
    return failures === 1
      ? `Dream finished with 1 failure. Saved ${facts} facts and ${events} events.`
      : `Dream finished with ${failures} failures. Saved ${facts} facts and ${events} events.`;
  }
  if (facts === 0 && events === 0) {
    return "Dream finished. No new memories.";
  }
  return `Dream finished. Saved ${facts} facts and ${events} events.`;
}

export function DreamProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [lastDreamedAt, setLastDreamedAt] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ollamaRunning, setOllamaRunning] = useState(true);
  const totalRef = useRef(0);
  totalRef.current = total;

  const prompt = useCallback(() => {
    if (running || !ollamaRunning) {
      return;
    }
    setConfirmOpen(true);
  }, [ollamaRunning, running]);

  const dismiss = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const start = useCallback(async () => {
    setConfirmOpen(false);
    if (running) {
      return;
    }
    setDone(0);
    setTotal(0);
    totalRef.current = 0;
    setRunning(true);
    try {
      const result = await startDream();
      setTotal(result.total);
      totalRef.current = result.total;
      setRunning(result.total > 0);
    } catch (error) {
      setRunning(false);
      setDone(0);
      setTotal(0);
      totalRef.current = 0;
      const message = formatDreamError(error);
      if (message === ollamaDownDreamMessage) {
        setOllamaRunning(false);
      }
      toast.error(message);
    }
  }, [running]);

  const refresh = useCallback(async () => {
    const ready = (await waitForNativeBridge()) && hasNativeBridge();
    if (!ready) {
      return;
    }
    try {
      const status = await getDreamStatus();
      setRunning(status.running);
      setDone(status.done);
      setTotal(status.total);
      setLastDreamedAt(status.lastDreamedAt);
    } catch {
      // A missing status leaves the idle pill; the next Dream click retries.
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const ready = (await waitForNativeBridge()) && hasNativeBridge();
      if (!ready || cancelled) {
        return;
      }
      try {
        const status = await getOllamaStatus();
        if (!cancelled) {
          setOllamaRunning(status.running);
        }
      } catch {
        if (!cancelled) {
          setOllamaRunning(false);
        }
      }
    };
    load().catch(() => undefined);
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, ollamaPollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(
    () =>
      onDreamStarted((payload) => {
        setDone(0);
        setTotal(payload.total);
        totalRef.current = payload.total;
        setRunning(payload.total > 0);
      }),
    []
  );

  useEffect(
    () =>
      onDreamProgress((payload) => {
        setDone(payload.done);
        setTotal(payload.total);
        totalRef.current = payload.total;
        setRunning(true);
      }),
    []
  );

  useEffect(
    () =>
      onDreamFinished((payload) => {
        setRunning(false);
        if (totalRef.current > 0) {
          setLastDreamedAt(new Date().toISOString());
        }
        toast.success(
          finishMessage(payload.facts, payload.events, payload.failures)
        );
        getDreamStatus()
          .then((status) => {
            if (status.lastDreamedAt) {
              setLastDreamedAt(status.lastDreamedAt);
            }
          })
          .catch(() => undefined);
      }),
    []
  );

  useEffect(
    () =>
      onDreamFailed((payload) => {
        setRunning(false);
        const message = formatDreamError(payload.message);
        if (message === ollamaDownDreamMessage) {
          setOllamaRunning(false);
        }
        toast.error(message);
      }),
    []
  );

  const state = useMemo<DreamState>(
    () => ({ confirmOpen, done, lastDreamedAt, ollamaRunning, running, total }),
    [confirmOpen, done, lastDreamedAt, ollamaRunning, running, total]
  );
  const actions = useMemo<DreamActions>(
    () => ({ dismiss, prompt, start }),
    [dismiss, prompt, start]
  );
  const value = useMemo<DreamContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return <DreamContext value={value}>{children}</DreamContext>;
}
