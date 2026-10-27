"use client";

import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";
import { memo, type ReactNode } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  JournalReadToolCard,
  renderJournalSearchCard,
} from "@/components/chat/journal-tool-cards";
import {
  ASSISTANT_PROSE_INSET,
  ASSISTANT_PROSE_SPACING,
} from "@/components/chat/transcript-column";
import { assistantPartIsVisible } from "@/lib/chat/assistant-pending";
import { assistantRuns } from "@/lib/chat/assistant-runs";
import {
  searchJournalToolName,
  toolPartFailed,
  toolPartName,
} from "@/lib/chat/tool-part";
import { cn } from "@/lib/utils";

export interface MessageBubbleProps {
  message: EveMessage;
}

const BUBBLE_CONTAINMENT =
  "[content-visibility:auto] [contain-intrinsic-size:auto_240px]";
const SEARCH_FOCUS_RING =
  "transition-shadow duration-500 data-[search-focus]:ring-2 data-[search-focus]:ring-ring/70 data-[search-focus]:[content-visibility:visible]";

function ChatMessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  return <AssistantMessage message={message} />;
}

export const MessageBubble = memo(ChatMessageBubble);
MessageBubble.displayName = "MessageBubble";

function UserMessage({ message }: { message: EveMessage }) {
  const body = userText(message);
  if (body.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        "w-full whitespace-pre-wrap break-words rounded-2xl border border-input bg-surface px-4 py-3 text-foreground text-sm",
        BUBBLE_CONTAINMENT,
        SEARCH_FOCUS_RING
      )}
      data-message-id={message.id}
      data-role="user"
    >
      {body}
    </div>
  );
}

function AssistantMessage({ message }: { message: EveMessage }) {
  const nodes: ReactNode[] = [];

  for (const run of assistantRuns(message.parts)) {
    if (run.kind === "reasoning") {
      nodes.push(
        <Reasoning
          className={ASSISTANT_PROSE_INSET}
          isStreaming={run.streaming}
          key={`${message.id}-reasoning-${run.index}`}
        >
          <ReasoningTrigger />
          <ReasoningContent>{run.texts.join("\n\n")}</ReasoningContent>
        </Reasoning>
      );
    } else if (run.kind === "reads") {
      nodes.push(
        <JournalReadToolCard
          key={`${message.id}-reads-${run.parts[0].toolCallId}`}
          parts={run.parts}
        />
      );
    } else {
      const node = renderAssistantPart(run.part, message.id, run.index);
      if (node) {
        nodes.push(node);
      }
    }
  }
  if (nodes.length === 0) {
    return null;
  }
  return (
    <div className="flex w-full justify-start" data-role="assistant">
      <div
        className={cn(
          "flex w-full flex-col gap-1 rounded-2xl",
          BUBBLE_CONTAINMENT,
          SEARCH_FOCUS_RING
        )}
        data-message-id={message.id}
      >
        {nodes}
      </div>
    </div>
  );
}

function renderAssistantPart(
  part: EveMessagePart,
  messageId: string,
  index: number
): ReactNode {
  if (part.type === "text") {
    if (!assistantPartIsVisible(part)) {
      return null;
    }
    return (
      <MessageResponse
        className={cn(
          "size-auto text-sm",
          ASSISTANT_PROSE_SPACING,
          ASSISTANT_PROSE_INSET
        )}
        isAnimating={part.state === "streaming"}
        key={`${messageId}-text-${index}`}
      >
        {part.text}
      </MessageResponse>
    );
  }
  if (part.type === "dynamic-tool") {
    return (
      <ToolCallBlock key={`${messageId}-tool-${part.toolCallId}`} part={part} />
    );
  }
  return null;
}

function ToolCallBlock({ part }: { part: EveDynamicToolPart }) {
  if (toolPartName(part) === searchJournalToolName) {
    const card = renderJournalSearchCard(part);
    if (card) {
      return card;
    }
  }

  const isError = toolPartFailed(part);
  const title = toolLabel(part);
  return (
    <Tool
      className={cn("mb-0", isError && "border-dragon/40")}
      data-tool-name={toolPartName(part)}
      data-tool-state={part.state}
    >
      <ToolHeader
        isError={isError}
        state={part.state}
        title={title}
        toolName={part.toolName}
      />
      <ToolContent>
        <div className="flex flex-col gap-4">
          <ToolInput input={part.input} />
          <ToolOutput
            errorText={
              part.state === "output-error" ? part.errorText : undefined
            }
            output={part.state === "output-available" ? part.output : undefined}
          />
        </div>
      </ToolContent>
    </Tool>
  );
}

function userText(message: EveMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function toolLabel(part: EveDynamicToolPart): string {
  const name = toolPartName(part);
  if (name === "facts__search_memories") {
    return part.state === "output-error"
      ? "Memory search failed"
      : "Searched memories";
  }
  if (part.state === "output-error") {
    return `${name} failed`;
  }
  if (part.state === "output-available") {
    return `Used ${name}`;
  }
  return `Using ${name}`;
}
