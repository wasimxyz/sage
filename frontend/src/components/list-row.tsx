import { AnimatePresence, m, useIsPresent } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCalendarDay } from "@/hooks/use-calendar-day";
import { formatJournalListDate, parseCalendarDate } from "@/lib/format-date";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One row of a list in a split view: a title and a date on a button, with a
 * right-click menu. Rows grow in and shrink out inside `AnimatePresence`.
 */

const skeletonRows = [0, 1, 2, 3, 4];
// Rows clip while they grow or shrink, and not at rest, so the focus ring
// that sits outside a row is not cut off.
const rowClosed = { height: 0, opacity: 0, overflow: "hidden" } as const;
const rowOpen = {
  height: "auto",
  opacity: 1,
  overflow: "hidden",
  transitionEnd: { overflow: "visible" },
} as const;
const rowClassName =
  "flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/15 active:duration-0";

function ListRowRoot({
  animateIn,
  children,
}: {
  /** True for a row that arrives on its own, which grows in. */
  animateIn: boolean;
  children: ReactNode;
}) {
  // A row that is leaving cannot take focus, and neighbors skip it.
  const isPresent = useIsPresent();
  return (
    <m.li
      animate={rowOpen}
      exit={rowClosed}
      inert={!isPresent}
      initial={animateIn ? rowClosed : false}
      transition={spring}
    >
      {/* The gap between rows lives inside, so the row can shrink to nothing. */}
      <div className="pb-0.5">
        <ContextMenu>{children}</ContextMenu>
      </div>
    </m.li>
  );
}

function ListRowTrigger({
  children,
  onClick,
  onKeyDown,
  selected,
}: {
  children: ReactNode;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  selected: boolean;
}) {
  return (
    <ContextMenuTrigger
      render={
        <button
          aria-current={selected ? "true" : undefined}
          aria-keyshortcuts="Meta+Backspace"
          className={cn(
            rowClassName,
            selected && "bg-foreground/10 hover:bg-foreground/10"
          )}
          onClick={onClick}
          onKeyDown={onKeyDown}
          type="button"
        />
      }
    >
      {children}
    </ContextMenuTrigger>
  );
}

function ListRowTitle({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate font-medium">{children}</span>;
}

/** `date` is a calendar day, `yyyy-MM-dd`. */
function ListRowDate({ date }: { date: string }) {
  // Today and Yesterday turn over at midnight, even if the row does not change.
  const today = useCalendarDay();
  return (
    <time className="shrink-0 text-muted-foreground" dateTime={date}>
      {formatJournalListDate(date, parseCalendarDate(today) ?? new Date())}
    </time>
  );
}

function ListRowMenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenuContent>
      <ContextMenuGroup>{children}</ContextMenuGroup>
    </ContextMenuContent>
  );
}

export const ListRow = {
  Date: ListRowDate,
  Menu: ListRowMenu,
  Root: ListRowRoot,
  Title: ListRowTitle,
  Trigger: ListRowTrigger,
};

/** The rows of a list, which grow and shrink as they come and go. */
export function ListRows({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-col">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ul>
  );
}

export function ListRowsSkeleton({ label }: { label: string }) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {skeletonRows.map((row) => (
        <div
          className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5"
          key={row}
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
