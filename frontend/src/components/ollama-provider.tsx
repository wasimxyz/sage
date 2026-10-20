import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useState,
} from "react";

import {
  getOllamaStatus,
  hasNativeBridge,
  listOllamaModels,
  startOllamaServer,
  waitForNativeBridge,
} from "@/bridge";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { type ModelsLoad, sameModelsLoad } from "@/lib/chat/models-load";
import { type OllamaStartLoad, ollamaStartFailed } from "@/lib/ollama-start";

const ollamaPollMs = 4000;

interface OllamaState {
  models: ModelsLoad;
  ollamaStart: OllamaStartLoad;
}

interface OllamaActions {
  /** A Dream that failed because Ollama is down says so before the next check. */
  markDown: () => void;
  refresh: () => Promise<void>;
  startOllama: () => Promise<void>;
}

interface OllamaContextValue {
  actions: OllamaActions;
  meta: Record<string, never>;
  state: OllamaState;
}

const OllamaContext = createContext<OllamaContextValue | null>(null);
const emptyMeta = {};

export function useOllama(): OllamaContextValue {
  const value = use(OllamaContext);
  if (!value) {
    throw new Error("OllamaProvider is missing.");
  }
  return value;
}

/**
 * The one Ollama check that Chat, Dream, and Settings > Models read, so the
 * app asks `embeddings.status` once every 4 seconds, not once per screen.
 */
export function OllamaProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<ModelsLoad>({ kind: "loading" });
  const [ollamaStart, setOllamaStart] = useState<OllamaStartLoad>({
    kind: "idle",
  });

  // Keep the old value when the check says the same thing, so the poll does
  // not re-render every screen that reads Ollama.
  const land = useCallback((next: ModelsLoad) => {
    setModels((current) => (sameModelsLoad(current, next) ? current : next));
  }, []);

  // Reads the Ollama status and, when it answers, the chat model list. The
  // warnings and the model picker all render what this lands.
  const refresh = useCallback(async () => {
    try {
      const ready = (await waitForNativeBridge()) && hasNativeBridge();
      if (!ready) {
        land({ kind: "down" });
        return;
      }
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
      land(names.length === 0 ? { kind: "empty" } : { kind: "ready", names });
    } catch {
      land({ kind: "down" });
    }
  }, [land]);

  useVisiblePoll(refresh, ollamaPollMs);

  const markDown = useCallback(() => {
    land({ kind: "down" });
  }, [land]);

  // The Start button in Chat and Settings: the core launches Ollama and
  // answers once the server replies, so the starting notice holds until this
  // resolves.
  const startOllama = useCallback(async () => {
    setOllamaStart({ kind: "starting" });
    try {
      await startOllamaServer();
      await refresh();
    } catch (caught) {
      setOllamaStart(ollamaStartFailed(caught));
    }
  }, [refresh]);

  const state = useMemo<OllamaState>(
    () => ({ models, ollamaStart }),
    [models, ollamaStart]
  );
  const actions = useMemo<OllamaActions>(
    () => ({ markDown, refresh, startOllama }),
    [markDown, refresh, startOllama]
  );
  const value = useMemo<OllamaContextValue>(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return <OllamaContext value={value}>{children}</OllamaContext>;
}
