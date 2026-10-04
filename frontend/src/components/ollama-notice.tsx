import { PauseIcon, TriangleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import type { OllamaStartLoad } from "@/components/chat-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const ollamaStartButtonClass = "min-w-28";

export function OllamaNotice({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border bg-surface px-3 py-2 text-card-foreground",
        className
      )}
      {...props}
      data-slot="ollama-notice"
      role="status"
    >
      {children}
    </div>
  );
}

export function OllamaNoticeIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
      {children}
    </span>
  );
}

function OllamaNoticeTitle({ children }: { children: string }) {
  return (
    <p className="min-w-0 flex-1 font-medium text-sm leading-5">{children}</p>
  );
}

export function OllamaNoticeCopy({
  description,
  title,
}: {
  description: ReactNode;
  title: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <OllamaNoticeTitle>{title}</OllamaNoticeTitle>
      <p className="text-muted-foreground text-xs leading-4">{description}</p>
    </div>
  );
}

function OllamaNoticeAction({ children }: { children: ReactNode }) {
  return <div className="shrink-0">{children}</div>;
}

function OllamaStartButton({ onStart }: { onStart: () => void }) {
  return (
    <Button
      className={cn(
        ollamaStartButtonClass,
        "rounded-lg [&:hover]:bg-foreground/6"
      )}
      onClick={onStart}
      size="sm"
      type="button"
      variant="outline"
    >
      Start Ollama
    </Button>
  );
}

function OllamaStartingButton() {
  return (
    <Button
      className={ollamaStartButtonClass}
      disabled
      size="sm"
      type="button"
      variant="outline"
    >
      Starting…
    </Button>
  );
}

function OllamaDownNotice({
  description,
  onStart,
}: {
  description?: ReactNode;
  onStart: () => void;
}) {
  return (
    <OllamaNotice>
      <OllamaNoticeIcon>
        <PauseIcon aria-hidden />
      </OllamaNoticeIcon>
      {description === undefined ? (
        <OllamaNoticeTitle>Ollama isn't running</OllamaNoticeTitle>
      ) : (
        <OllamaNoticeCopy
          description={description}
          title="Ollama isn't running"
        />
      )}
      <OllamaNoticeAction>
        <OllamaStartButton onStart={onStart} />
      </OllamaNoticeAction>
    </OllamaNotice>
  );
}

function OllamaStartingNotice() {
  return (
    <OllamaNotice aria-busy>
      <OllamaNoticeIcon>
        <Spinner aria-hidden role="presentation" />
      </OllamaNoticeIcon>
      <OllamaNoticeTitle>Starting Ollama…</OllamaNoticeTitle>
      <OllamaNoticeAction>
        <OllamaStartingButton />
      </OllamaNoticeAction>
    </OllamaNotice>
  );
}

function OllamaStartFailedNotice({
  message,
  onStart,
}: {
  message: string;
  onStart: () => void;
}) {
  return (
    <OllamaNotice>
      <OllamaNoticeIcon>
        <TriangleAlertIcon aria-hidden />
      </OllamaNoticeIcon>
      <OllamaNoticeCopy description={message} title="Ollama isn't running" />
      <OllamaNoticeAction>
        <OllamaStartButton onStart={onStart} />
      </OllamaNoticeAction>
    </OllamaNotice>
  );
}

/**
 * The notice for a down Ollama, with the Start Ollama button. `start` is the
 * state of the last start; a failed start shows its reason in place of
 * `description`.
 */
export function OllamaStartNotice({
  description,
  onStart,
  start,
}: {
  description?: ReactNode;
  onStart: () => void;
  start: OllamaStartLoad;
}) {
  if (start.kind === "starting") {
    return <OllamaStartingNotice />;
  }
  if (start.kind === "failed") {
    return (
      <OllamaStartFailedNotice message={start.message} onStart={onStart} />
    );
  }
  return <OllamaDownNotice description={description} onStart={onStart} />;
}
