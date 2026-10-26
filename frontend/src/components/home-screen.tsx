import { MessageCircleIcon, NotebookTextIcon, PencilIcon } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { useChat, useChatPanel } from "@/components/chat-provider";
import { Clouds } from "@/components/clouds";
import {
  useJournalActions,
  useJournalEntries,
} from "@/components/journal-context";
import {
  ListRow,
  ListRowsSkeleton,
  listRowClassName,
} from "@/components/list-row";
import { ProtectReminder } from "@/components/protect-reminder";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useHomeNow } from "@/hooks/use-home-now";
import { useWeekStartsOn } from "@/hooks/use-week-starts-on";
import { formatHomeHeadingDate } from "@/lib/format-date";
import {
  greetingFor,
  groupHomeItems,
  type HomeGroup,
  type HomeRow,
  homeRowDate,
  type MonthDay,
  monthAgoEntry,
  monthAgoLine,
  monthDays,
  monthName,
} from "@/lib/home";
import { pageColumnClass } from "@/lib/page-column";
import { toHash } from "@/lib/route";
import { cn } from "@/lib/utils";

const groupTitles: readonly { group: HomeGroup; title: string }[] = [
  { group: "today", title: "Today" },
  { group: "thisWeek", title: "This week" },
  { group: "lastWeek", title: "Last week" },
];

// Past the text, so the clouds never come up under it.
const textClearancePx = 24;

// Where the sidebar button ends, if the page cannot measure it.
const sidebarButtonBottomPx = 40;

// One square is 0.75 rem wide, and at most 0.5 rem apart.
const squareRem = 0.75;
const squareGapRem = 0.5;

// White on the band, with the band's own color showing in the gap.
const bandFocusClassName =
  "focus-visible:border-white focus-visible:ring-white/70";

/**
 * Opening an entry or a chat from Home fills the window with it, and the list
 * is one step back. The Journal and Chat lists open it beside the list.
 */
function useOpenFullScreen() {
  const { select, setExpanded, showChat } = useJournalActions();
  const {
    actions: { openConversation },
  } = useChat();
  const {
    actions: { setExpanded: setChatExpanded },
  } = useChatPanel();
  // Full screen stays set after Journal or Chat is left. Coming back to Home
  // ends it, so New entry and New chat open beside their lists.
  useEffect(() => {
    setExpanded(false);
    setChatExpanded(false);
  }, [setChatExpanded, setExpanded]);
  const openEntry = useCallback(
    (id: number) => {
      select(id)
        .then(() => {
          setExpanded(true);
        })
        .catch(() => {
          // The editor toasts its own load errors.
        });
    },
    [select, setExpanded]
  );
  const openChat = useCallback(
    (id: number) => {
      showChat()
        .then(() => {
          openConversation(id);
          setChatExpanded(true);
        })
        .catch(() => {
          // showChat flushes the editor; openers toast their own errors.
        });
    },
    [openConversation, setChatExpanded, showChat]
  );
  return { openChat, openEntry };
}

export function HomeScreen() {
  const { openChat, openEntry } = useOpenFullScreen();
  // Rows waiting out their undo window are already out of both lists.
  const { entries, loadingList } = useJournalEntries();
  const {
    state: { conversations, listLoaded },
  } = useChat();
  const weekStartsOn = useWeekStartsOn();
  const now = useHomeNow();

  const loading = loadingList || !listLoaded || weekStartsOn === null;
  const days = useMemo(() => monthDays(entries, now), [entries, now]);
  const monthAgo = useMemo(() => monthAgoEntry(entries, now), [entries, now]);
  const groups = useMemo(
    () => groupHomeItems(entries, conversations, now, weekStartsOn ?? 0),
    [entries, conversations, now, weekStartsOn]
  );
  const nothingYet = entries.length === 0 && conversations.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <CloudBand
          monthAgo={
            monthAgo === null
              ? null
              : { id: monthAgo.id, line: monthAgoLine(monthAgo.title) }
          }
          now={now}
          onOpenEntry={openEntry}
        />
        <div className={cn(pageColumnClass, "flex flex-col gap-8 pt-8 pb-8")}>
          <MonthRow
            days={days}
            loading={loading}
            monthLabel={monthName(now)}
            onOpenEntry={openEntry}
          />
          <HomeLists
            groups={groups}
            loading={loading}
            nothingYet={nothingYet}
            onOpenChat={openChat}
            onOpenEntry={openEntry}
          />
        </div>
      </ScrollArea>
      <ProtectReminder ready={!loading} />
    </div>
  );
}

function CloudBand({
  monthAgo,
  now,
  onOpenEntry,
}: {
  monthAgo: { id: number; line: string } | null;
  now: Date;
  onOpenEntry: (id: number) => void;
}) {
  const { showChat, startDraft } = useJournalActions();
  const {
    actions: { newChat },
  } = useChat();
  const [clearUntil, setClearUntil] = useState(0);

  // The band stays dark and cloud-free under the text, however wide the window.
  const measureBand = useCallback((band: HTMLDivElement | null) => {
    const text = band?.querySelector("[data-band-text]");
    if (!(band && text)) {
      return;
    }
    const measure = () => {
      const { right } = text.getBoundingClientRect();
      const { left } = band.getBoundingClientRect();
      setClearUntil(Math.round(right - left + textClearancePx));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);

  // The sidebar button sits over the band while the sidebar is closed, and it
  // needs white there. That lasts until the band's bottom edge scrolls up past
  // the button, so the observer's top edge is the button's bottom edge.
  const watchBandBottom = useCallback((sentinel: HTMLDivElement | null) => {
    if (!sentinel) {
      return;
    }
    const root = document.documentElement;
    const button = document.querySelector("[data-sidebar='trigger']");
    const buttonBottom = Math.ceil(
      button?.getBoundingClientRect().bottom || sidebarButtonBottomPx
    );
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          root.dataset.titlebar = "band";
        } else {
          root.removeAttribute("data-titlebar");
        }
      },
      { rootMargin: `-${buttonBottom}px 0px 0px 0px` }
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      root.removeAttribute("data-titlebar");
    };
  }, []);

  const handleNewChat = useCallback(() => {
    showChat()
      .then(() => {
        newChat();
      })
      .catch(() => {
        // showChat flushes the editor; it toasts its own errors.
      });
  }, [newChat, showChat]);

  const handleStartDraft = useCallback(() => {
    startDraft().catch(() => undefined);
  }, [startDraft]);

  return (
    <div
      className="relative overflow-hidden text-white"
      ref={measureBand}
      style={{
        backgroundImage: `linear-gradient(to right, var(--band-from) ${clearUntil}px, var(--band-to))`,
      }}
    >
      <Clouds
        anchor="right"
        className="pointer-events-none absolute inset-0 size-full"
        clearUntil={clearUntil}
      />
      {/* Above the text column, which covers the whole band and would take
          every press meant for the window. Nothing the strip covers is a
          control. */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-(--titlebar-height)"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      />
      {/* A speck on the band's bottom edge. While it is below the sidebar
          button, the band is under the button. */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 h-px w-0.5"
        ref={watchBandBottom}
      />
      <div
        className={cn(
          pageColumnClass,
          "relative flex min-h-[186px] items-center py-[38px]"
        )}
      >
        <div
          className="flex w-full max-w-md flex-col items-start"
          data-band-text
        >
          <p className="text-white/90 text-xs leading-4">
            {formatHomeHeadingDate(now)}
          </p>
          <h1 className="mt-0.5 font-semibold text-2xl leading-tight tracking-tight">
            {greetingFor(now)}
          </h1>
          {monthAgo === null ? null : (
            <p className="mt-1 text-[13px] text-white/90 leading-snug">
              {monthAgo.line}{" "}
              <RereadLink id={monthAgo.id} onOpen={onOpenEntry} />
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              aria-keyshortcuts="Meta+N"
              className={cn(
                "h-7.5 bg-white px-3.5 text-(--band-from) hover:bg-white/90 active:bg-white/80 has-data-[icon=inline-start]:pl-3",
                bandFocusClassName
              )}
              onClick={handleStartDraft}
              size="sm"
            >
              <PencilIcon className="size-3" data-icon="inline-start" />
              New entry
            </Button>
            <Button
              className={cn(
                "h-7.5 border-white/50 bg-white/10 px-3.5 text-white hover:bg-white/20 hover:text-white active:bg-white/25 has-data-[icon=inline-start]:pl-3 dark:border-white/50 dark:bg-white/10 dark:hover:bg-white/20",
                bandFocusClassName
              )}
              onClick={handleNewChat}
              size="sm"
              variant="outline"
            >
              <MessageCircleIcon className="size-3" data-icon="inline-start" />
              New chat
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RereadLink({
  id,
  onOpen,
}: {
  id: number;
  onOpen: (id: number) => void;
}) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onOpen(id);
    },
    [id, onOpen]
  );
  return (
    <a
      className="whitespace-nowrap rounded-xs font-semibold text-white underline decoration-2 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-(--band-from) focus-visible:ring-offset-2"
      href={`#${toHash({ entryId: id, section: "journal" })}`}
      onClick={handleClick}
    >
      Reread
    </a>
  );
}

function MonthRow({
  days,
  loading,
  monthLabel,
  onOpenEntry,
}: {
  days: MonthDay[];
  loading: boolean;
  monthLabel: string;
  onOpenEntry: (id: number) => void;
}) {
  const labelId = useId();
  const count = days.length;
  // A month has 28 to 31 squares, so the wide row is as long as the month and
  // its squares still end at the right edge of the column.
  const monthVars = {
    "--days": count,
    "--month-width": `${count * squareRem + (count - 1) * squareGapRem}rem`,
  } as CSSProperties;
  return (
    <div
      className="@container flex items-start justify-between gap-x-3"
      style={monthVars}
    >
      {/* As tall as a square's cell, so the label lines up with the first row
          of squares when the row wraps. */}
      <span
        className="flex h-6 min-w-14 shrink-0 items-center text-muted-foreground text-sm"
        id={labelId}
      >
        {monthLabel}
      </span>
      {loading ? (
        <Skeleton className="mt-1.5 h-3 max-w-(--month-width) flex-1" />
      ) : (
        // The squares end at the right edge of the column. They fill one row
        // when it fits, spaced 8 px apart at most, and two aligned rows when it
        // does not.
        <fieldset
          aria-labelledby={labelId}
          className="grid min-w-0 @md:max-w-(--month-width) flex-1 @md:grid-cols-[repeat(var(--days),0.75rem)] grid-cols-[repeat(16,0.75rem)] justify-between"
        >
          {days.map((day) => (
            <DaySquare day={day} key={day.date} onOpenEntry={onOpenEntry} />
          ))}
        </fieldset>
      )}
    </div>
  );
}

function DaySquare({
  day,
  onOpenEntry,
}: {
  day: MonthDay;
  onOpenEntry: (id: number) => void;
}) {
  const { entryId } = day;
  const handleClick = useCallback(() => {
    if (entryId !== null) {
      onOpenEntry(entryId);
    }
  }, [entryId, onOpenEntry]);
  return (
    <button
      aria-current={day.today ? "date" : undefined}
      aria-label={day.label}
      className="group/day relative flex h-6 items-center justify-center rounded-sm outline-none after:absolute after:-inset-x-1 after:inset-y-0 enabled:cursor-pointer"
      disabled={entryId === null}
      onClick={handleClick}
      type="button"
    >
      <span
        className={cn(
          "size-3 rounded-[3px] transition-transform group-focus-visible/day:ring-[3px] group-focus-visible/day:ring-ring/50 group-enabled/day:group-hover/day:scale-125",
          day.state === "written" && "bg-brand",
          day.state === "empty" && "bg-foreground/10",
          day.state === "future" && "border border-foreground/20",
          day.today && "outline-2 outline-foreground outline-offset-2"
        )}
      />
    </button>
  );
}

function HomeLists({
  groups,
  loading,
  nothingYet,
  onOpenChat,
  onOpenEntry,
}: {
  groups: Record<HomeGroup, HomeRow[]>;
  loading: boolean;
  nothingYet: boolean;
  onOpenChat: (id: number) => void;
  onOpenEntry: (id: number) => void;
}) {
  if (loading) {
    return <ListRowsSkeleton label="Loading Home" />;
  }
  if (nothingYet) {
    return (
      <p className="text-base text-muted-foreground">
        Your entries and chats will show up here.
      </p>
    );
  }
  if (groupTitles.every(({ group }) => groups[group].length === 0)) {
    return (
      <p className="text-base text-muted-foreground">
        Nothing from this week or last week. Older entries are in Journal, and
        older chats are in Chat.
      </p>
    );
  }
  return (
    <>
      {groupTitles.map(({ group, title }) =>
        groups[group].length === 0 ? null : (
          <HomeSection key={group} title={title}>
            {groups[group].map((row) => (
              <HomeListRow
                group={group}
                key={`${row.kind}-${row.id}`}
                onOpenChat={onOpenChat}
                onOpenEntry={onOpenEntry}
                row={row}
              />
            ))}
          </HomeSection>
        )
      )}
    </>
  );
}

function HomeSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function HomeListRow({
  group,
  onOpenChat,
  onOpenEntry,
  row,
}: {
  group: HomeGroup;
  onOpenChat: (id: number) => void;
  onOpenEntry: (id: number) => void;
  row: HomeRow;
}) {
  const { id, kind } = row;
  const handleClick = useCallback(() => {
    if (kind === "entry") {
      onOpenEntry(id);
    } else {
      onOpenChat(id);
    }
  }, [id, kind, onOpenChat, onOpenEntry]);
  const Icon = kind === "entry" ? NotebookTextIcon : MessageCircleIcon;
  return (
    <li className="pb-0.5">
      <button
        className={cn(listRowClassName, "-mx-3 w-[calc(100%+1.5rem)]")}
        onClick={handleClick}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Icon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <ListRow.Title>
            <span className="sr-only">
              {kind === "entry" ? "Entry: " : "Chat: "}
            </span>
            {row.title}
          </ListRow.Title>
        </span>
        <time
          className="shrink-0 text-muted-foreground"
          dateTime={group === "today" ? row.updatedAt : row.day}
        >
          {homeRowDate(row, group)}
        </time>
      </button>
    </li>
  );
}
