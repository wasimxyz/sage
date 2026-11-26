import { AnimatePresence, m, useIsPresent } from "motion/react";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCalendarDay } from "@/hooks/use-calendar-day";
import { formatSidebarDate, parseCalendarDate } from "@/lib/format-date";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One row of a list in the sidebar: a title and a date on a button, with a
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
const listRowClassName =
  "group/row flex h-8.5 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 text-left text-sm text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent focus-visible:ring-2 active:bg-foreground/15 active:duration-0";

function ListRowRoot({
  actionsRef,
  animateIn,
  children,
}: {
  /** Lets a screen close the row's menu, such as when the list hides. */
  actionsRef?: ComponentProps<typeof ContextMenu>["actionsRef"];
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
      <div className="pb-px">
        <ContextMenu actionsRef={actionsRef}>{children}</ContextMenu>
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
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts="Meta+Backspace"
          className={cn(
            listRowClassName,
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
  return <span className="min-w-0 truncate">{children}</span>;
}

/** `date` is a calendar day, `yyyy-MM-dd`. */
function ListRowDate({ date }: { date: string }) {
  // Today and Yesterday turn over at midnight, even if the row does not change.
  const today = useCalendarDay();
  // The open row's gray background needs a darker date to stay readable.
  return (
    <time
      className="text-muted-foreground group-aria-[current=page]/row:text-sidebar-foreground/75 shrink-0 text-xs"
      dateTime={date}
    >
      {formatSidebarDate(date, parseCalendarDate(today) ?? new Date())}
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
          className="flex h-8.5 items-center justify-between gap-3 px-2.5"
          key={row}
        >
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** One gray line, for a list with nothing in it. */
export function ListEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground px-2.5 py-1.5 text-sm">{children}</p>
  );
}
