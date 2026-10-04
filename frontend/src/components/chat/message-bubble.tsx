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
  JournalEntryToolCard,
  JournalSearchToolCard,
} from "@/components/chat/journal-tool-cards";
import {
  ASSISTANT_PROSE_INSET,
  ASSISTANT_PROSE_SPACING,
} from "@/components/chat/transcript-column";
import { assistantPartIsVisible } from "@/lib/chat/assistant-pending";
import {
  journalBodyContent,
  journalEntryOutput,
  journalSearchHits,
  journalSearchQuery,
} from "@/lib/chat/journal-tool-output";
import { cn } from "@/lib/utils";

export interface MessageBubbleProps {
  message: EveMessage;
}

const BUBBLE_CONTAINMENT =
  "[content-visibility:auto] [contain-intrinsic-size:auto_240px]";
const SEARCH_FOCUS_RING =
  "data-[search-focus]:ring-2 data-[search-focus]:ring-ring/70 data-[search-focus]:[content-visibility:visible]";

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
  // Consecutive reasoning parts become one thinking row so a streamed
  // trace does not stack multiple "Thinking..." triggers.
  let reasoningRun: {
    index: number;
    streaming: boolean;
    texts: string[];
  } | null = null;

  const flushReasoning = () => {
    if (!reasoningRun) {
      return;
    }
    nodes.push(
      <Reasoning
        className={ASSISTANT_PROSE_INSET}
        isStreaming={reasoningRun.streaming}
        key={`${message.id}-reasoning-${reasoningRun.index}`}
      >
        <ReasoningTrigger />
        <ReasoningContent>{reasoningRun.texts.join("\n\n")}</ReasoningContent>
      </Reasoning>
    );
    reasoningRun = null;
  };

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "reasoning") {
      if (!assistantPartIsVisible(part)) {
        continue;
      }
      const streaming = part.state === "streaming";
      if (reasoningRun) {
        reasoningRun.texts.push(part.text);
        reasoningRun.streaming = streaming;
      } else {
        reasoningRun = { index, streaming, texts: [part.text] };
      }
      continue;
    }
    flushReasoning();
    const node = renderAssistantPart(part, message.id, index);
    if (node) {
      nodes.push(node);
    }
  }
  flushReasoning();
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
  const journalTool = renderJournalToolCard(part);
  if (journalTool) {
    return journalTool;
  }

  const isError = partHasError(part);
  const title = toolLabel(part);
  return (
    <Tool
      className={cn("mb-0", isError && "border-dragon/40")}
      data-tool-name={part.toolMetadata?.eve?.name ?? part.toolName}
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

function renderJournalToolCard(part: EveDynamicToolPart): ReactNode | null {
  if (part.state !== "output-available" || partHasError(part)) {
    return null;
  }
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  if (name === "search_journal") {
    const query = journalSearchQuery(part.input);
    const hits = journalSearchHits(part.output);
    return query === null || hits === null ? null : (
      <JournalSearchToolCard hits={hits} query={query} />
    );
  }
  if (name === "get_journal_entry") {
    const entry = journalEntryOutput(part.output);
    if (!entry) {
      return null;
    }
    const bodyContent = journalBodyContent(entry);
    return bodyContent ? (
      <JournalEntryToolCard bodyContent={bodyContent} entry={entry} />
    ) : null;
  }
  return null;
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

function partHasError(part: EveDynamicToolPart): boolean {
  if (part.state === "output-error") {
    return true;
  }
  return part.state === "output-available" && isMcpErrorOutput(part.output);
}

function isMcpErrorOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  return (output as { isError?: unknown }).isError === true;
}

function toolLabel(part: EveDynamicToolPart): string {
  const name = part.toolMetadata?.eve?.name ?? part.toolName;
  if (name === "search_journal") {
    return part.state === "output-error"
      ? "Journal search failed"
      : "Searched the journal";
  }
  if (name === "get_journal_entry") {
    return part.state === "output-error"
      ? "Could not read that entry"
      : "Read an entry";
  }
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
