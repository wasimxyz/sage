import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { ModelRowState } from "@/lib/model-queue";

/** What a model row says on the right, without its button. */
export function modelStateLabel(state: ModelRowState): string {
  switch (state.kind) {
    case "ready":
      return "Ready";
    case "downloading":
      return state.percent === null
        ? "Downloading"
        : `Downloading ${state.percent}%`;
    case "problem":
      return state.message;
    case "unavailable":
      return "Not downloaded";
    case "checking":
      return "Checking";
    default:
      return "Waiting";
  }
}

/** One model on the downloads screen: its name, its purpose, and its state. */
export function ModelDownloadRow({
  name,
  onCancel,
  onRetry,
  purpose,
  state,
}: {
  name: string;
  onCancel: () => void;
  onRetry: (name: string) => void;
  purpose: string;
  state: ModelRowState;
}) {
  return (
    <div className="flex flex-col gap-2 p-3" data-state={state.kind}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium font-mono text-sm">{name}</span>
          <span className="text-muted-foreground text-sm">{purpose}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          {state.kind === "ready" ? (
            <span className="flex items-center gap-1 text-primary">
              <CheckIcon className="size-4" />
              Ready
            </span>
          ) : (
            <span
              aria-live="polite"
              className={
                state.kind === "problem"
                  ? "text-destructive"
                  : "text-muted-foreground tabular-nums"
              }
            >
              {modelStateLabel(state)}
            </span>
          )}
          {state.kind === "downloading" ? (
            <Button onClick={onCancel} size="sm" variant="outline">
              Cancel
            </Button>
          ) : null}
          {state.kind === "problem" ? (
            <RetryButton name={name} onRetry={onRetry} />
          ) : null}
        </div>
      </div>
      {state.kind === "downloading" ? (
        <Progress aria-label={`Downloading ${name}`} value={state.percent} />
      ) : null}
    </div>
  );
}

function RetryButton({
  name,
  onRetry,
}: {
  name: string;
  onRetry: (name: string) => void;
}) {
  const handleClick = useCallback(() => onRetry(name), [name, onRetry]);
  return (
    <Button onClick={handleClick} size="sm" variant="outline">
      Download
    </Button>
  );
}

/** One model on All set: a line, and a live bar while it downloads. */
export function ModelStatusLine({
  name,
  state,
}: {
  name: string;
  state: ModelRowState;
}) {
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <StatusIcon state={state} />
          <span className="min-w-0 truncate">
            <span className="font-mono">{name}</span> {statusSentence(state)}
          </span>
        </span>
        {state.kind === "downloading" && state.percent !== null ? (
          <span className="text-muted-foreground tabular-nums">
            {state.percent}%
          </span>
        ) : null}
      </div>
      {state.kind === "downloading" ? (
        <Progress aria-label={`Downloading ${name}`} value={state.percent} />
      ) : null}
    </div>
  );
}

function StatusIcon({ state }: { state: ModelRowState }) {
  if (state.kind === "ready") {
    return <CheckIcon className="size-4 shrink-0 text-primary" />;
  }
  if (state.kind === "problem" || state.kind === "unavailable") {
    return (
      <CircleAlertIcon className="size-4 shrink-0 text-muted-foreground" />
    );
  }
  return <Spinner aria-hidden className="shrink-0" />;
}

function statusSentence(state: ModelRowState): string {
  switch (state.kind) {
    case "ready":
      return "is ready";
    case "downloading":
      return "is downloading";
    case "problem":
      return `did not download. ${state.message}`;
    case "unavailable":
      return "is not downloaded. Finish in Settings › Models.";
    case "checking":
      return "is being checked";
    default:
      return "is waiting to download";
  }
}
