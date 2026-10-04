import { ChevronDownIcon } from "lucide-react";
import { useCallback, useState } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorModels,
  ModelSelectorModelsContent,
  ModelSelectorModelsTrigger,
  ModelSelectorName,
  ModelSelectorRow,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { useChat } from "@/components/chat-provider";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CONTEXT_LENGTHS, formatContextLength } from "@/lib/chat/model-prefs";

const MODEL_PILL_CLASS =
  "h-8 max-w-48 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground hover:!bg-foreground/6 aria-expanded:!bg-foreground/9";

export function ModelPicker() {
  const {
    state: { agent, models },
  } = useChat();
  if (agent.kind === "down") {
    return <ModelPickerDisabled />;
  }
  if (models.kind === "ready") {
    return <ModelPickerReady names={models.names} />;
  }
  if (models.kind === "loading") {
    return <ModelPickerLoading />;
  }
  return <ModelPickerUnavailable />;
}

function ModelPickerDisabled() {
  const {
    state: { selectedModel },
  } = useChat();
  return (
    <PromptInputButton
      className={MODEL_PILL_CLASS}
      disabled
      size="sm"
      variant="ghost"
    >
      <span className="truncate font-medium">{selectedModel || "Model"}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
    </PromptInputButton>
  );
}

function ModelPickerReady({ names }: { names: string[] }) {
  const {
    actions: { setThinkingEnabled },
    state: { selectedModel, thinkingEnabled },
  } = useChat();
  const [open, setOpen] = useState(false);
  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger
        render={
          <PromptInputButton
            aria-expanded={open}
            aria-label="Select model"
            className={MODEL_PILL_CLASS}
            size="sm"
            variant="ghost"
          />
        }
      >
        <span className="truncate font-medium">{selectedModel || "Model"}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ContextLengthMenu onPicked={setOpen} />
        <ModelSelectorRow
          checked={thinkingEnabled}
          onCheckedChange={setThinkingEnabled}
        >
          Thinking
          <Switch
            aria-hidden
            checked={thinkingEnabled}
            className="pointer-events-none after:hidden"
            size="sm"
            tabIndex={-1}
          />
        </ModelSelectorRow>
        <ModelSelectorModels>
          <ModelSelectorModelsTrigger>
            <span className="shrink-0">Model</span>
            <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
              {selectedModel || "Choose"}
            </span>
          </ModelSelectorModelsTrigger>
          <ModelSelectorModelsContent>
            <ModelSelectorInput placeholder="Search models" />
            <ModelSelectorList>
              <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
              <ModelSelectorGroup>
                {names.map((name) => (
                  <ModelCommandItem
                    key={name}
                    name={name}
                    onPicked={setOpen}
                    selected={name === selectedModel}
                  />
                ))}
              </ModelSelectorGroup>
            </ModelSelectorList>
          </ModelSelectorModelsContent>
        </ModelSelectorModels>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

function ContextLengthMenu({
  onPicked,
}: {
  onPicked: (open: boolean) => void;
}) {
  const {
    state: { contextLength, contextLengthLocked },
  } = useChat();
  const label = formatContextLength(contextLength);
  if (contextLengthLocked) {
    return (
      <DropdownMenuItem
        aria-disabled
        className="w-full justify-between gap-3"
        disabled
      >
        <span className="shrink-0">Context length</span>
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          {label}
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <ModelSelectorModels>
      <ModelSelectorModelsTrigger>
        <span className="shrink-0">Context length</span>
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          {label}
        </span>
      </ModelSelectorModelsTrigger>
      <ModelSelectorModelsContent className="w-36">
        <ModelSelectorList>
          <ModelSelectorGroup>
            {CONTEXT_LENGTHS.map((value) => (
              <ContextLengthCommandItem
                key={value}
                onPicked={onPicked}
                selected={value === contextLength}
                value={value}
              />
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorModelsContent>
    </ModelSelectorModels>
  );
}

function ModelPickerLoading() {
  return (
    <PromptInputButton
      className={MODEL_PILL_CLASS}
      disabled
      size="sm"
      variant="ghost"
    >
      <span className="font-medium">Loading models</span>
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
    </PromptInputButton>
  );
}

function ModelPickerUnavailable() {
  const {
    state: { models },
  } = useChat();
  const hint =
    models.kind === "down"
      ? "Start Ollama so Sage can list local models."
      : "No chat models. Run ollama pull qwen3.5:9b.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <PromptInputButton
            className={MODEL_PILL_CLASS}
            disabled
            size="sm"
            variant="ghost"
          />
        }
      >
        <span className="font-medium">No models</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function ModelCommandItem({
  name,
  onPicked,
  selected,
}: {
  name: string;
  onPicked: (open: boolean) => void;
  selected: boolean;
}) {
  const {
    actions: { selectModel },
  } = useChat();
  const onSelect = useCallback(() => {
    selectModel(name);
    onPicked(false);
  }, [name, onPicked, selectModel]);
  return (
    <ModelSelectorItem
      data-checked={selected ? "true" : undefined}
      onSelect={onSelect}
      value={name}
    >
      <ModelSelectorName>{name}</ModelSelectorName>
    </ModelSelectorItem>
  );
}

function ContextLengthCommandItem({
  onPicked,
  selected,
  value,
}: {
  onPicked: (open: boolean) => void;
  selected: boolean;
  value: number;
}) {
  const {
    actions: { setContextLength },
  } = useChat();
  const onSelect = useCallback(() => {
    setContextLength(value);
    onPicked(false);
  }, [onPicked, setContextLength, value]);
  const label = formatContextLength(value);
  return (
    <ModelSelectorItem
      data-checked={selected ? "true" : undefined}
      onSelect={onSelect}
      value={label}
    >
      <ModelSelectorName>{label}</ModelSelectorName>
    </ModelSelectorItem>
  );
}
