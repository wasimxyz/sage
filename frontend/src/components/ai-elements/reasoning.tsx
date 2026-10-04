"use client";

import { ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const AUTO_CLOSE_DELAY_MS = 1000;
const MS_IN_S = 1000;
const emptyMeta = {};

interface ReasoningState {
  duration: number;
  isOpen: boolean;
  isStreaming: boolean;
}

interface ReasoningActions {
  setIsOpen: (open: boolean) => void;
}

interface ReasoningContextValue {
  actions: ReasoningActions;
  meta: Record<string, never>;
  state: ReasoningState;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning(): ReasoningContextValue {
  const value = use(ReasoningContext);
  if (!value) {
    throw new Error("Reasoning components must be used within <Reasoning>");
  }
  return value;
}

export type ReasoningProps = Omit<
  ComponentProps<typeof Collapsible>,
  "onOpenChange"
> & {
  duration?: number;
  isStreaming?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const isControlled = open !== undefined;
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isOpen = isControlled ? open : internalOpen;

    const setIsOpen = useCallback(
      (next: boolean) => {
        if (!isControlled) {
          setInternalOpen(next);
        }
        onOpenChange?.(next);
      },
      [isControlled, onOpenChange]
    );

    const [measuredDuration, setMeasuredDuration] = useState(0);
    const duration = durationProp ?? measuredDuration;

    const startRef = useRef<number | null>(null);
    useEffect(() => {
      if (isStreaming) {
        if (startRef.current === null) {
          startRef.current = Date.now();
        }
        return;
      }
      if (startRef.current !== null) {
        setMeasuredDuration(
          Math.round((Date.now() - startRef.current) / MS_IN_S)
        );
        startRef.current = null;
      }
    }, [isStreaming]);

    const hasAutoClosedRef = useRef(false);
    useEffect(() => {
      if (
        !(isStreaming || defaultOpen) &&
        isOpen &&
        !hasAutoClosedRef.current
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          hasAutoClosedRef.current = true;
        }, AUTO_CLOSE_DELAY_MS);
        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, defaultOpen, setIsOpen]);

    const contextValue = useMemo<ReasoningContextValue>(
      () => ({
        actions: { setIsOpen },
        meta: emptyMeta,
        state: { duration, isOpen, isStreaming },
      }),
      [duration, isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext value={contextValue}>
        <Collapsible
          {...props}
          className={cn("not-prose w-full", className)}
          data-reasoning=""
          onOpenChange={setIsOpen}
          open={isOpen}
        >
          {children}
        </Collapsible>
      </ReasoningContext>
    );
  }
);

Reasoning.displayName = "Reasoning";

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export const ReasoningTrigger = memo(
  ({ className, children, ...props }: ReasoningTriggerProps) => {
    const {
      state: { duration, isOpen, isStreaming },
    } = useReasoning();

    let label = "Reasoning";
    if (isStreaming) {
      label = "Thinking...";
    } else if (duration > 0) {
      label = `Thought for ${duration} second${duration === 1 ? "" : "s"}`;
    }

    return (
      <CollapsibleTrigger
        className={cn(
          "flex h-8 cursor-pointer items-center gap-1.5 font-sans text-muted-foreground text-sm",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <span>{label}</span>
            <ChevronDown
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

ReasoningTrigger.displayName = "ReasoningTrigger";

export type ReasoningContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "children"
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-3 mb-3 overflow-hidden border-muted-foreground/20 border-l-2 pl-3 text-muted-foreground text-sm",
        "data-closed:fade-out-0 data-closed:slide-out-to-top-1 data-open:slide-in-from-top-1 outline-none data-closed:animate-out data-open:animate-in",
        className
      )}
      {...props}
    >
      <MessageResponse className="grid gap-2">{children}</MessageResponse>
    </CollapsibleContent>
  )
);

ReasoningContent.displayName = "ReasoningContent";
