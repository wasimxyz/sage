"use client";

import type { EveDynamicToolPart } from "eve/client";
import { Fragment, type ReactNode, useCallback } from "react";

import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { useJournalActions } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  type JournalToolEntry,
  journalEntryOutput,
  journalSearchHits,
  journalSearchQuery,
  journalSearchRange,
  journalSearchSummary,
} from "@/lib/chat/journal-tool-output";
import {
  readEntryToolName,
  searchJournalToolName,
  toolErrorText,
  toolPartFailed,
  toolPartRunning,
} from "@/lib/chat/tool-part";
import { formatEntryDate, formatShortEntryDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";

const toolHeaderClassName = "h-8 w-full justify-start";

// A card opens its entry in the expanded editor, not beside the list.
function useOpenEntryExpanded(id: number) {
  const { select, setExpanded } = useJournalActions();
  return useCallback(async () => {
    await select(id);
    setExpanded(true);
  }, [id, select, setExpanded]);
}

function entriesLabel(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

interface ListRow {
  key: string;
  node: ReactNode;
}

// The open card: rows in a rounded box, as in a list in Journal.
function JournalToolList({ rows }: { rows: ListRow[] }) {
  return (
    <ToolContent className="border-0 bg-transparent p-0 text-foreground">
      <div className="overflow-hidden rounded-2xl border border-input bg-surface">
        {rows.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? <Separator /> : null}
            {row.node}
          </Fragment>
        ))}
      </div>
    </ToolContent>
  );
}

// A line of the card that is not an entry, so it is muted and not a button.
function JournalToolNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-h-9 items-center px-4 py-2 text-muted-foreground text-sm">
      {children}
    </p>
  );
}

function JournalEntryRow({ date, id, title }: JournalToolEntry) {
  const openEntry = useOpenEntryExpanded(id);
  const name = title.trim() || "Untitled";

  return (
    <Button
      aria-label={`Open journal entry: ${name}, ${formatEntryDate(date)}`}
      className="h-10 w-full justify-between gap-3 rounded-none px-4 text-left font-normal text-sm"
      data-entry-id={id}
      onClick={openEntry}
      type="button"
      variant="ghost"
    >
      <span className="min-w-0 truncate text-foreground">{name}</span>
      <time className="shrink-0 text-muted-foreground" dateTime={date}>
        {formatShortEntryDate(date)}
      </time>
    </Button>
  );
}

function entryRows(entries: JournalToolEntry[]): ListRow[] {
  return entries.map((entry) => ({
    key: `entry-${entry.id}`,
    node: <JournalEntryRow {...entry} />,
  }));
}

// A step that has not finished has nothing to open yet, so it is a shimmering
// label with no chevron.
function JournalRunningRow({
  label,
  state,
  toolName,
}: {
  label: string;
  state: EveDynamicToolPart["state"];
  toolName: string;
}) {
  return (
    <Tool data-tool-name={toolName} data-tool-state={state}>
      <ToolHeader
        className={cn(toolHeaderClassName, "cursor-default")}
        disabled
        showChevron={false}
        state={state}
        title={label}
        toolName={toolName}
      />
    </Tool>
  );
}

function JournalFailedRow({
  messages,
  state,
  title,
  toolName,
}: {
  messages: string[];
  state: EveDynamicToolPart["state"];
  title: string;
  toolName: string;
}) {
  return (
    <Tool data-tool-name={toolName} data-tool-state={state}>
      <ToolHeader
        className={toolHeaderClassName}
        isError
        state={state}
        title={title}
        toolName={toolName}
      />
      <JournalToolList
        rows={messages.map((message) => ({
          key: message,
          node: <JournalToolNote>{message}</JournalToolNote>,
        }))}
      />
    </Tool>
  );
}

/**
 * One `search_journal` call: what was searched for, then the entries found.
 * Null when the result is not one this card knows, so the caller can show the
 * raw call instead. It is a function and not a component for that reason.
 */
export function renderJournalSearchCard(
  part: EveDynamicToolPart
): ReactNode | null {
  if (toolPartRunning(part)) {
    return (
      <JournalRunningRow
        label="Searching journal…"
        state={part.state}
        toolName={searchJournalToolName}
      />
    );
  }
  if (toolPartFailed(part)) {
    return (
      <JournalFailedRow
        messages={[toolErrorText(part) ?? "The search did not finish."]}
        state={part.state}
        title="Journal search failed"
        toolName={searchJournalToolName}
      />
    );
  }
  if (part.state !== "output-available") {
    return null;
  }
  const hits = journalSearchHits(part.output);
  if (hits === null) {
    return null;
  }

  const summary = journalSearchSummary(
    journalSearchQuery(part.input),
    journalSearchRange(part.output)
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
  if (hits.length === 0) {
    rows.push({
      key: "empty",
      node: <JournalToolNote>No matching entries</JournalToolNote>,
    });
  } else {
    rows.push(...entryRows(hits));
  }

  return (
    <Tool data-tool-name={searchJournalToolName} data-tool-state={part.state}>
      <ToolHeader
        className={toolHeaderClassName}
        state={part.state}
        title="Searched journal"
        toolName={searchJournalToolName}
      />
      <JournalToolList rows={rows} />
    </Tool>
  );
}

/**
 * Reads of journal entries that came one after the other, as one row. An entry
 * read twice shows once.
 */
export function JournalReadToolCard({
  parts,
}: {
  parts: EveDynamicToolPart[];
}) {
  if (parts.some(toolPartRunning)) {
    return (
      <JournalRunningRow
        label={`Reading ${entriesLabel(parts.length)}…`}
        state="input-available"
        toolName={readEntryToolName}
      />
    );
  }

  const entries = new Map<number, JournalToolEntry>();
  const errors = new Set<string>();
  let failed = 0;
  for (const part of parts) {
    const entry =
      !toolPartFailed(part) && part.state === "output-available"
        ? journalEntryOutput(part.output)
        : null;
    if (entry === null) {
      failed += 1;
      errors.add(toolErrorText(part) ?? "The entry could not be read.");
    } else if (!entries.has(entry.id)) {
      entries.set(entry.id, entry);
    }
  }

  if (entries.size === 0) {
    return (
      <JournalFailedRow
        messages={[...errors]}
        state="output-error"
        title={
          failed === 1
            ? "Could not read that entry"
            : `Could not read ${entriesLabel(failed)}`
        }
        toolName={readEntryToolName}
      />
    );
  }

  const rows = entryRows([...entries.values()]);
  if (failed > 0) {
    rows.push({
      key: "failed",
      node: (
        <JournalToolNote>Could not read {entriesLabel(failed)}</JournalToolNote>
      ),
    });
  }
  return (
    <Tool data-tool-name={readEntryToolName} data-tool-state="output-available">
      <ToolHeader
        className={toolHeaderClassName}
        state="output-available"
        title={`Read ${entriesLabel(entries.size)}`}
        toolName={readEntryToolName}
      />
      <JournalToolList rows={rows} />
    </Tool>
  );
}
