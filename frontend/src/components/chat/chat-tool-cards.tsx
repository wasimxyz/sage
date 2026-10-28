"use client";

import type { EveDynamicToolPart } from "eve/client";
import { type ReactNode, useCallback } from "react";

import { Tool, ToolHeader } from "@/components/ai-elements/tool";
import {
  JournalFailedRow,
  JournalRunningRow,
  JournalToolList,
  JournalToolNote,
  type ListRow,
  toolHeaderClassName,
} from "@/components/chat/journal-tool-cards";
import { useChat } from "@/components/chat-provider";
import { useJournalActions } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import {
  type ChatToolHit,
  chatReadOutput,
  chatSearchHits,
} from "@/lib/chat/chat-tool-output";
import {
  journalSearchQuery,
  journalSearchRange,
  journalSearchSummary,
} from "@/lib/chat/journal-tool-output";
import {
  readChatToolName,
  searchChatsToolName,
  toolErrorText,
  toolPartFailed,
  toolPartRunning,
} from "@/lib/chat/tool-part";
import { formatEntryDate, formatShortEntryDate } from "@/lib/format-date";

function chatsLabel(count: number): string {
  return count === 1 ? "1 past chat" : `${count} past chats`;
}

// A row opens its chat at the message the tool found, or at its end.
function PastChatRow({ date, id, seq, title }: ChatToolHit) {
  const { showChat } = useJournalActions();
  const {
    actions: { openConversation },
  } = useChat();
  const open = useCallback(async () => {
    await showChat();
    openConversation(id, seq === null ? undefined : { seq });
  }, [id, openConversation, seq, showChat]);
  const name = title.trim() || "New chat";

  return (
    <Button
      aria-label={
        date === null
          ? `Open chat: ${name}`
          : `Open chat: ${name}, ${formatEntryDate(date)}`
      }
      className="h-10 w-full justify-between gap-3 rounded-none px-4 text-left font-normal text-sm"
      data-chat-id={id}
      onClick={open}
      type="button"
      variant="ghost"
    >
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {date === null ? null : (
        <time className="shrink-0 text-muted-foreground" dateTime={date}>
          {formatShortEntryDate(date)}
        </time>
      )}
    </Button>
  );
}

function chatRows(chats: ChatToolHit[]): ListRow[] {
  return chats.map((chat) => ({
    key: `chat-${chat.id}-${chat.seq ?? "end"}`,
    node: <PastChatRow {...chat} />,
  }));
}

/**
 * One `search_chats` call: what was searched for, then the chats found. Null
 * when the result is not one this card knows, so the caller can show the raw
 * call instead.
 */
export function renderChatSearchCard(
  part: EveDynamicToolPart
): ReactNode | null {
  if (toolPartRunning(part)) {
    return (
      <JournalRunningRow
        label="Searching past chats…"
        state={part.state}
        toolName={searchChatsToolName}
      />
    );
  }
  if (toolPartFailed(part)) {
    return (
      <JournalFailedRow
        messages={[toolErrorText(part) ?? "The search did not finish."]}
        state={part.state}
        title="Chat search failed"
        toolName={searchChatsToolName}
      />
    );
  }
  if (part.state !== "output-available") {
    return null;
  }
  const chats = chatSearchHits(part.output);
  if (chats === null) {
    return null;
  }

  const summary = journalSearchSummary(
    journalSearchQuery(part.input),
    journalSearchRange(part.output),
    new Date(),
    "Chats"
  );
  const rows: ListRow[] = [];
  if (summary !== null) {
    rows.push({
      key: "summary",
      node: (
        <JournalToolNote>
          <span className="min-w-0 truncate">
            {summary.lead}
            {summary.query === null ? null : (
              <span className="text-foreground">{summary.query}</span>
            )}
            {summary.rest}
          </span>
        </JournalToolNote>
      ),
    });
  }
  if (chats.length === 0) {
    rows.push({
      key: "empty",
      node: <JournalToolNote>No matching chats</JournalToolNote>,
    });
  } else {
    rows.push(...chatRows(chats));
  }

  return (
    <Tool data-tool-name={searchChatsToolName} data-tool-state={part.state}>
      <ToolHeader
        className={toolHeaderClassName}
        state={part.state}
        title="Searched past chats"
        toolName={searchChatsToolName}
      />
      <JournalToolList rows={rows} />
    </Tool>
  );
}

/**
 * Reads of past chats that came one after the other, as one row. The same
 * part of a chat read twice shows once.
 */
export function ChatReadToolCard({ parts }: { parts: EveDynamicToolPart[] }) {
  if (parts.some(toolPartRunning)) {
    return (
      <JournalRunningRow
        label={`Reading ${chatsLabel(parts.length)}…`}
        state="input-available"
        toolName={readChatToolName}
      />
    );
  }

  const reads = new Map<string, ChatToolHit>();
  const errors = new Set<string>();
  let failed = 0;
  for (const part of parts) {
    const read =
      !toolPartFailed(part) && part.state === "output-available"
        ? chatReadOutput(part.input, part.output)
        : null;
    if (read === null) {
      failed += 1;
      errors.add(toolErrorText(part) ?? "The chat could not be read.");
      continue;
    }
    const key = `${read.id}-${read.seq ?? "end"}`;
    if (!reads.has(key)) {
      reads.set(key, read);
    }
  }

  if (reads.size === 0) {
    return (
      <JournalFailedRow
        messages={[...errors]}
        state="output-error"
        title={
          failed === 1
            ? "Could not read that chat"
            : `Could not read ${chatsLabel(failed)}`
        }
        toolName={readChatToolName}
      />
    );
  }

  const rows = chatRows([...reads.values()]);
  if (failed > 0) {
    rows.push({
      key: "failed",
      node: (
        <JournalToolNote>Could not read {chatsLabel(failed)}</JournalToolNote>
      ),
    });
  }
  return (
    <Tool data-tool-name={readChatToolName} data-tool-state="output-available">
      <ToolHeader
        className={toolHeaderClassName}
        state="output-available"
        title={`Read ${chatsLabel(reads.size)}`}
        toolName={readChatToolName}
      />
      <JournalToolList rows={rows} />
    </Tool>
  );
}
