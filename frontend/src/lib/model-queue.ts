import type { OllamaPullProgress } from "@/bridge";
import { findInstalledName } from "./models.ts";

// The download queue takes one model at a time, because Ollama pulls one at a
// time. The core keeps only the last pull, so this decides what to do next from
// that pull, the saved queue, and which model this page started itself. A pull
// left over from before is never read as the queue's own.

export type QueueStep =
  /** Nothing is waiting. */
  | { kind: "idle" }
  /** The head finished one way or another, so take it off the queue. */
  | {
      kind: "finish";
      model: string;
      outcome: "cancelled" | "done" | "failed";
    }
  /** Start the head. */
  | { kind: "start"; model: string }
  /** The head is downloading now. Remember it as started. */
  | { kind: "watch"; model: string }
  /** Another download is running, so the head waits its turn. */
  | { kind: "wait" };

/** True when a pull is for this model, by the same rule the model lists use. */
export function pullMatches(
  pull: Pick<OllamaPullProgress, "model">,
  model: string
): boolean {
  return findInstalledName(model, [pull.model]) !== null;
}

export function nextQueueStep(input: {
  pull: OllamaPullProgress | null;
  queue: readonly string[];
  started: string | null;
}): QueueStep {
  const { pull, queue, started } = input;
  const [head] = queue;
  if (head === undefined) {
    return pull?.active ? { kind: "wait" } : { kind: "idle" };
  }
  if (pull?.active) {
    return pullMatches(pull, head)
      ? { kind: "watch", model: head }
      : { kind: "wait" };
  }
  if (started === head && pull !== null && pullMatches(pull, head)) {
    if (pull.done) {
      return { kind: "finish", model: head, outcome: "done" };
    }
    if (pull.cancelled) {
      return { kind: "finish", model: head, outcome: "cancelled" };
    }
    if (pull.failed) {
      return { kind: "finish", model: head, outcome: "failed" };
    }
  }
  return { kind: "start", model: head };
}

/** Add models to the end of a queue, skipping any already in it. */
export function enqueueModels(
  queue: readonly string[],
  models: readonly string[]
): string[] {
  const next = [...queue];
  for (const model of models) {
    if (!next.includes(model)) {
      next.push(model);
    }
  }
  return next;
}

/** What one model's row says on the downloads screen and on All set. */
export type ModelRowState =
  /** Sage has not read which models are pulled yet. */
  | { kind: "checking" }
  | { kind: "downloading"; percent: number | null }
  | { kind: "problem"; message: string }
  | { kind: "ready" }
  /** Ollama is not running and nothing is queued, so there is nothing to show. */
  | { kind: "unavailable" }
  | { kind: "waiting" };

export function modelRowState(input: {
  model: string;
  problems: Readonly<Record<string, string>>;
  pull: OllamaPullProgress | null;
  queue: readonly string[];
  /** Whether Ollama has the model, or null before Sage has looked. */
  ready: boolean | null;
  running: boolean;
}): ModelRowState {
  const { model, problems, pull, queue, ready, running } = input;
  if (ready) {
    return { kind: "ready" };
  }
  if (pull?.active && pullMatches(pull, model)) {
    const percent =
      pull.total > 0
        ? Math.min(100, Math.round((pull.completed / pull.total) * 100))
        : null;
    return { kind: "downloading", percent };
  }
  const problem = problems[model];
  if (problem !== undefined) {
    return { kind: "problem", message: problem };
  }
  if (queue.includes(model)) {
    return { kind: "waiting" };
  }
  if (ready === null) {
    return { kind: "checking" };
  }
  return running ? { kind: "waiting" } : { kind: "unavailable" };
}
