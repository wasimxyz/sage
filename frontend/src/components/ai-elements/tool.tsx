"use client";

import type { EveDynamicToolPart } from "eve/react";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDown,
  ClockIcon,
  CopyIcon,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  isError?: boolean;
  state: EveDynamicToolPart["state"];
  title?: string;
  toolName: string;
};

const statusLabels: Record<EveDynamicToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<EveDynamicToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": null,
  "input-streaming": null,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <X className="size-3.5 text-dragon" />,
  "output-error": <X className="size-3.5 text-dragon" />,
};

export const getStatusBadge = (
  status: EveDynamicToolPart["state"],
  isError?: boolean
) => {
  const effective: EveDynamicToolPart["state"] = isError
    ? "output-error"
    : status;
  if (effective === "output-available") {
    return null;
  }
  if (effective === "input-streaming" || effective === "input-available") {
    return null;
  }
  if (effective === "output-error") {
    return (
      <span className="inline-flex items-center text-dragon">
        {statusIcons[effective]}
        <span className="sr-only">{statusLabels[effective]}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs">
      {statusIcons[effective]}
      {statusLabels[effective]}
    </span>
  );
};

export const ToolHeader = ({
  children,
  className,
  isError,
  state,
  title,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const label = title ?? toolName;
  const isInProgress =
    (state === "input-streaming" || state === "input-available") && !isError;

  return (
    <CollapsibleTrigger
      className={cn(
        "group/tool-trigger flex h-8 max-w-full cursor-pointer items-center gap-1.5 px-[calc(1rem+1px)] font-sans text-muted-foreground text-sm",
        className
      )}
      {...props}
    >
      {children ??
        (isInProgress ? (
          <Shimmer as="span" className="min-w-0 truncate font-sans text-sm">
            {label}
          </Shimmer>
        ) : (
          <span className="min-w-0 truncate font-sans text-sm">{label}</span>
        ))}
      {getStatusBadge(state, isError)}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-open/tool-trigger:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 mt-1 overflow-hidden rounded-2xl border border-input bg-surface px-4 py-3 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in",
      className
    )}
    {...props}
  />
);

interface McpTextEnvelope {
  content: Array<{ type: string; text?: unknown }>;
}

const isMcpTextEnvelope = (value: unknown): value is McpTextEnvelope => {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return false;
  }
  const { content } = value as { content: unknown };
  return (
    Array.isArray(content) &&
    content.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { text?: unknown }).text === "string"
    )
  );
};

const prettyPrintIfJson = (text: string): string => {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
};

const formatForDisplay = (value: unknown): string => {
  if (typeof value === "string") {
    return prettyPrintIfJson(value);
  }
  if (isMcpTextEnvelope(value)) {
    const text = value.content
      .filter(
        (item): item is { type: string; text: string } =>
          typeof item.text === "string"
      )
      .map((item) => item.text)
      .join("\n");
    return prettyPrintIfJson(text);
  }
  return JSON.stringify(value, null, 2);
};

const toolCopyButtonClassName =
  "absolute top-1.5 right-1.5 z-10 size-7 rounded-md bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground";

function ToolCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      () => undefined
    );
  }, [code]);
  return (
    <Button
      aria-label="Copy"
      className={toolCopyButtonClassName}
      onClick={onCopy}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  );
}

const ToolCopyableShell = ({
  children,
  code,
}: {
  children: ReactNode;
  code: string;
}) => (
  <div className="relative">
    <ToolCopyButton code={code} />
    {children}
  </div>
);

const ToolCodePanel = ({
  className,
  code,
}: {
  className?: string;
  code: string;
}) => (
  <ToolCopyableShell code={code}>
    <pre
      className={cn(
        "hide-scrollbar max-h-96 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md border p-3 pr-10 text-xs",
        className
      )}
    >
      {code}
    </pre>
  </ToolCopyableShell>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: EveDynamicToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  if (input === undefined) {
    return null;
  }
  return (
    <div
      className={cn("flex flex-col gap-2 overflow-hidden", className)}
      {...props}
    >
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Parameters
      </h4>
      <ToolCodePanel code={formatForDisplay(input)} />
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  errorText: EveDynamicToolPart["errorText"];
  output: EveDynamicToolPart["output"];
};

export const ToolOutput = ({
  className,
  errorText,
  output,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  const hasElementOutput = isValidElement(output);
  const hasDataOutput =
    output !== undefined && output !== null && !hasElementOutput;

  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      {errorText ? (
        <ToolCopyableShell code={errorText}>
          <div className="hide-scrollbar max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-dragon/10 p-3 text-dragon text-xs">
            {errorText}
          </div>
        </ToolCopyableShell>
      ) : null}
      {hasElementOutput ? (
        <div className="hide-scrollbar overflow-x-auto rounded-md bg-surface text-foreground text-xs [&_table]:w-full">
          {output as ReactNode}
        </div>
      ) : null}
      {hasDataOutput ? <ToolCodePanel code={formatForDisplay(output)} /> : null}
    </div>
  );
};
