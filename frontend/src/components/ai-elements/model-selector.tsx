"use client";

import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  use,
  useMemo,
  useRef,
} from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const modelsCollisionAvoidance = {
  align: "none",
  fallbackAxisSide: "none",
  side: "none",
} as const;

interface ModelSelectorPanelContextValue {
  panelRef: RefObject<HTMLDivElement | null>;
}

const ModelSelectorPanelContext =
  createContext<ModelSelectorPanelContextValue | null>(null);

function ModelSelectorPanel({ children }: { children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const value = useMemo<ModelSelectorPanelContextValue>(
    () => ({ panelRef }),
    []
  );
  return (
    <ModelSelectorPanelContext value={value}>
      {children}
    </ModelSelectorPanelContext>
  );
}

export type ModelSelectorProps = ComponentProps<typeof DropdownMenu>;

export const ModelSelector = (props: ModelSelectorProps) => (
  <ModelSelectorPanel>
    <DropdownMenu {...props} />
  </ModelSelectorPanel>
);

export type ModelSelectorTriggerProps = ComponentProps<
  typeof DropdownMenuTrigger
>;

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DropdownMenuTrigger {...props} />
);

export type ModelSelectorContentProps = ComponentProps<
  typeof DropdownMenuContent
>;

export const ModelSelectorContent = ({
  align = "start",
  className,
  side = "top",
  sideOffset = 4,
  ...props
}: ModelSelectorContentProps) => {
  const panelRef = use(ModelSelectorPanelContext)?.panelRef;
  return (
    <DropdownMenuContent
      align={align}
      className={cn("flex w-64 min-w-64 flex-col gap-1.5 p-1.5", className)}
      ref={panelRef}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
};

export type ModelSelectorRowProps = ComponentProps<
  typeof DropdownMenuCheckboxItem
>;

export const ModelSelectorRow = ({
  className,
  ...props
}: ModelSelectorRowProps) => (
  <DropdownMenuCheckboxItem
    className={cn(
      "hover:!bg-foreground/6 data-state-checked:!bg-foreground/9 w-full justify-between gap-3 pr-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden",
      className
    )}
    {...props}
  />
);

export type ModelSelectorModelsProps = ComponentProps<typeof DropdownMenuSub>;

export const ModelSelectorModels = ({
  children,
  ...props
}: ModelSelectorModelsProps) => (
  <DropdownMenuGroup>
    <DropdownMenuSub {...props}>{children}</DropdownMenuSub>
  </DropdownMenuGroup>
);

export type ModelSelectorModelsTriggerProps = ComponentProps<
  typeof DropdownMenuSubTrigger
>;

export const ModelSelectorModelsTrigger = ({
  className,
  ...props
}: ModelSelectorModelsTriggerProps) => (
  <DropdownMenuSubTrigger
    className={cn(
      "hover:!bg-foreground/6 aria-expanded:!bg-foreground/9 w-full",
      className
    )}
    {...props}
  />
);

export type ModelSelectorModelsContentProps = ComponentProps<
  typeof DropdownMenuSubContent
>;

export const ModelSelectorModelsContent = ({
  children,
  className,
  align = "end",
  alignOffset = 0,
  sideOffset = 8,
  ...props
}: ModelSelectorModelsContentProps) => {
  const panelRef = use(ModelSelectorPanelContext)?.panelRef;
  return (
    <DropdownMenuSubContent
      align={align}
      alignOffset={alignOffset}
      anchor={panelRef}
      className={cn("w-72 overflow-hidden p-1.5", className)}
      collisionAvoidance={modelsCollisionAvoidance}
      sideOffset={sideOffset}
      {...props}
    >
      <Command
        className="h-auto w-full p-0 **:data-[slot=command-input-wrapper]:mb-1.5 **:data-[slot=command-input-wrapper]:h-auto"
        onKeyDown={stopMenuTypeahead}
      >
        {children}
      </Command>
    </DropdownMenuSubContent>
  );
};

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({
  className,
  ...props
}: ModelSelectorInputProps) => (
  <CommandInput
    className={cn("mb-1.5 py-0.5 text-sm leading-tight", className)}
    {...props}
  />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = ({
  className,
  ...props
}: ModelSelectorListProps) => (
  <CommandList className={cn("hide-scrollbar", className)} {...props} />
);

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const ModelSelectorGroup = ({
  className,
  ...props
}: ModelSelectorGroupProps) => (
  <CommandGroup className={cn("p-0", className)} {...props} />
);

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = ({
  className,
  ...props
}: ModelSelectorItemProps) => (
  <CommandItem
    className={cn(
      "hover:!bg-foreground/6 data-selected:!bg-foreground/9 mb-0.5 last:mb-0",
      className
    )}
    {...props}
  />
);

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({
  className,
  ...props
}: ModelSelectorNameProps) => (
  <span className={cn("flex-1 truncate text-left", className)} {...props} />
);

function stopMenuTypeahead(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === "Escape") {
    return;
  }
  event.stopPropagation();
}
