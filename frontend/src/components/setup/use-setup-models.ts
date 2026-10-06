import { useEffect, useMemo, useState } from "react";

import {
  getOllamaSetupStatus,
  getOllamaStatus,
  listOllamaModels,
} from "@/bridge";
import { useModelDownloads } from "@/components/model-downloads-provider";
import { type ModelRowState, modelRowState } from "@/lib/model-queue";
import { findInstalledName } from "@/lib/models";

export interface SetupModelNames {
  embed: string;
  summary: string;
}

/** The names Sage looks for when the core cannot be asked. Mirrors `src/ollama.zig`. */
export const defaultModelNames: SetupModelNames = {
  embed: "nomic-embed-text",
  summary: "qwen3.5:9b",
};

export interface SetupModelRow {
  name: string;
  purpose: string;
  state: ModelRowState;
}

interface Readiness {
  embed: boolean;
  running: boolean;
  summary: boolean;
}

/**
 * The two models Sage needs, with what each row should say right now. Whether
 * a model is pulled comes from Ollama itself, and is read again whenever a
 * download finishes. The download state comes from the shared provider, so
 * the screen is live after setup moves on.
 */
export function useSetupModels() {
  const {
    state: { completed, problems, pull, queue },
  } = useModelDownloads();
  const [names, setNames] = useState<SetupModelNames | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished download changes which models Ollama has, so read them again
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const setup = await getOllamaSetupStatus();
        const nextNames = {
          embed: setup.embedModel,
          summary: setup.summaryModel,
        };
        if (!setup.running) {
          if (!cancelled) {
            setNames(nextNames);
            setReadiness({ embed: false, running: false, summary: false });
          }
          return;
        }
        // `ollama.models` leaves out the embedding model, so that one comes
        // from `embeddings.status`.
        const [status, installed] = await Promise.all([
          getOllamaStatus(),
          listOllamaModels(),
        ]);
        if (!cancelled) {
          setNames(nextNames);
          setReadiness({
            embed: status.modelPulled,
            running: true,
            summary: findInstalledName(nextNames.summary, installed) !== null,
          });
        }
      } catch {
        // Leave the rows as they were. The next download refreshes them.
      }
    };
    read().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [completed]);

  const rows = useMemo<SetupModelRow[]>(() => {
    if (names === null) {
      return [];
    }
    const state = (model: string, ready: boolean | null) =>
      modelRowState({
        model,
        problems,
        pull,
        queue,
        ready,
        running: readiness?.running ?? false,
      });
    return [
      {
        name: names.embed,
        purpose: "Finds entries by meaning.",
        state: state(names.embed, readiness?.embed ?? null),
      },
      {
        name: names.summary,
        purpose: "Writes chat replies, summaries, and titles.",
        state: state(names.summary, readiness?.summary ?? null),
      },
    ];
  }, [names, problems, pull, queue, readiness]);

  return { names, readiness, rows };
}
