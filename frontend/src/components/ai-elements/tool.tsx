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
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsibleHeightMotion,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  isError?: boolean;
  showChevron?: boolean;
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
  "output-denied": <X className="text-dragon size-3.5" />,
  "output-error": <X className="text-dragon size-3.5" />,
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
      <span className="text-dragon inline-flex items-center">
        {statusIcons[effective]}
        <span className="sr-only">{statusLabels[effective]}</span>
      </span>
    );
  }
  return (
    <span className="bg-secondary text-secondary-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs">
      {statusIcons[effective]}
      {statusLabels[effective]}
    </span>
  );
};

export const ToolHeader = ({
  children,
  className,
  isError,
  showChevron = true,
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
        "group/tool-trigger text-muted-foreground flex h-8 max-w-full cursor-pointer items-center gap-1.5 px-[calc(1rem+1px)] font-sans text-sm",
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
      {showChevron ? (
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-open/tool-trigger:rotate-180" />
      ) : null}
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({
  className,
  children,
  ...props
}: ToolContentProps) => (
  <CollapsibleContent className={collapsibleHeightMotion} {...props}>
    <div
      className={cn(
        "border-input bg-surface text-popover-foreground mt-1 rounded-2xl border px-4 py-3",
        className
      )}
    >
      {children}
    </div>
  </CollapsibleContent>
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
    <Hint label={copied ? "Copied" : "Copy"}>
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
    </Hint>
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
        "hide-scrollbar max-h-96 overflow-x-hidden overflow-y-auto rounded-md border p-3 pr-10 text-xs break-all whitespace-pre-wrap",
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
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
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
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {errorText ? "Error" : "Result"}
      </h4>
      {errorText ? (
        <ToolCopyableShell code={errorText}>
          <div className="hide-scrollbar bg-dragon/10 text-dragon max-h-96 overflow-y-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
            {errorText}
          </div>
        </ToolCopyableShell>
      ) : null}
      {hasElementOutput ? (
        <div className="hide-scrollbar bg-surface text-foreground overflow-x-auto rounded-md text-xs [&_table]:w-full">
          {output as ReactNode}
        </div>
      ) : null}
      {hasDataOutput ? <ToolCodePanel code={formatForDisplay(output)} /> : null}
    </div>
  );
};
