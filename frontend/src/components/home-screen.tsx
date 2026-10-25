import { MessageCircleIcon, NotebookTextIcon, PencilIcon } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { useChat } from "@/components/chat-provider";
import { Clouds } from "@/components/clouds";
import {
  useJournalActions,
  useJournalEntries,
} from "@/components/journal-context";
import { ProtectReminder } from "@/components/protect-reminder";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useHiddenIds } from "@/hooks/use-hidden-ids";
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

const rowClassName =
  "-mx-3 flex h-12 w-[calc(100%+1.5rem)] cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-[15px] outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/15 active:duration-0";

// White on the band, with the band's own color showing in the gap.
const bandFocusClassName =
  "focus-visible:border-white focus-visible:ring-white/70";

export function HomeScreen() {
  const { select } = useJournalActions();
  const { entries, loadingList } = useJournalEntries();
  const {
    state: { conversations, listLoaded },
  } = useChat();
  const hiddenEntries = useHiddenIds("entry");
  const weekStartsOn = useWeekStartsOn();
  const now = useHomeNow();

  // Rows waiting out their undo window stay out of Home. Chats are already
  // filtered by the chat provider.
  const visibleEntries = useMemo(
    () =>
      hiddenEntries.size === 0
        ? entries
        : entries.filter((entry) => !hiddenEntries.has(entry.id)),
    [entries, hiddenEntries]
  );
  const loading = loadingList || !listLoaded || weekStartsOn === null;
  const days = useMemo(
    () => monthDays(visibleEntries, now),
    [visibleEntries, now]
  );
  const monthAgo = useMemo(
    () => monthAgoEntry(visibleEntries, now),
    [visibleEntries, now]
  );
  const groups = useMemo(
    () => groupHomeItems(visibleEntries, conversations, now, weekStartsOn ?? 0),
    [visibleEntries, conversations, now, weekStartsOn]
  );
  const nothingYet = visibleEntries.length === 0 && conversations.length === 0;

  const openEntry = useCallback(
    (id: number) => {
      select(id).catch(() => {
        // The editor toasts its own load errors.
      });
    },
    [select]
  );

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
          />
          <EndButtons />
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

  // The sidebar button sits over the band while the sidebar is closed and the
  // band is at the top, and it needs white there.
  const watchBandTop = useCallback((sentinel: HTMLDivElement | null) => {
    if (!sentinel) {
      return;
    }
    const root = document.documentElement;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        root.dataset.titlebar = "band";
      } else {
        root.removeAttribute("data-titlebar");
      }
    });
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
      className="relative min-h-75 overflow-hidden text-white"
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
      <div
        className="absolute inset-x-0 top-0 h-(--titlebar-height)"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      />
      {/* A speck at the sidebar button's height. While it is on screen, the
          band is under the button. */}
      <div
        className="pointer-events-none absolute top-6.5 left-0 size-0.5"
        ref={watchBandTop}
      />
      <div
        className={cn(
          pageColumnClass,
          "relative pt-[calc(var(--titlebar-height)+0.125rem)] pb-10"
        )}
      >
        <div className="flex max-w-md flex-col items-start" data-band-text>
          <p className="text-[15px] text-white/90 leading-normal">
            {formatHomeHeadingDate(now)}
          </p>
          <h1 className="mt-1.5 font-semibold text-[2.375rem] leading-tight tracking-tight">
            {greetingFor(now)}
          </h1>
          {monthAgo === null ? null : (
            <p className="mt-2 text-[15px] text-white/90 leading-normal">
              {monthAgo.line}{" "}
              <RereadLink id={monthAgo.id} onOpen={onOpenEntry} />
            </p>
          )}
          <div className="mt-7 flex flex-wrap gap-3">
            <Button
              aria-keyshortcuts="Meta+N"
              className={cn(
                "h-11.5 bg-white px-5 text-(--band-from) text-base hover:bg-white/90 active:bg-white/80",
                bandFocusClassName
              )}
              onClick={handleStartDraft}
            >
              <PencilIcon data-icon="inline-start" />
              New entry
            </Button>
            <Button
              className={cn(
                "h-11.5 border-white/50 bg-white/10 px-5 text-base text-white hover:bg-white/20 hover:text-white active:bg-white/25 dark:border-white/50 dark:bg-white/10 dark:hover:bg-white/20",
                bandFocusClassName
              )}
              onClick={handleNewChat}
              variant="outline"
            >
              <MessageCircleIcon data-icon="inline-start" />
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span
        className="min-w-14 shrink-0 text-[15px] text-muted-foreground"
        id={labelId}
      >
        {monthLabel}
      </span>
      {loading ? (
        <Skeleton className="h-3 w-full max-w-xl" />
      ) : (
        <fieldset aria-labelledby={labelId} className="flex flex-wrap">
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
      className="group/day flex h-6 w-5 items-center justify-center rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 enabled:cursor-pointer"
      disabled={entryId === null}
      onClick={handleClick}
      type="button"
    >
      <span
        className={cn(
          "size-3 rounded-[3px] transition-transform group-enabled/day:group-hover/day:scale-125",
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
}: {
  groups: Record<HomeGroup, HomeRow[]>;
  loading: boolean;
  nothingYet: boolean;
}) {
  if (loading) {
    return <HomeListsSkeleton />;
  }
  if (nothingYet) {
    return (
      <p className="text-base text-muted-foreground">
        Your entries and chats will show up here.
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
    <section className="flex flex-col gap-0.5">
      <h2 className="font-medium text-[15px] text-muted-foreground">{title}</h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function HomeListRow({ group, row }: { group: HomeGroup; row: HomeRow }) {
  const { select, showChat } = useJournalActions();
  const {
    actions: { openConversation },
  } = useChat();
  const { id, kind } = row;
  const handleClick = useCallback(() => {
    if (kind === "entry") {
      select(id).catch(() => {
        // The editor toasts its own load errors.
      });
      return;
    }
    showChat()
      .then(() => {
        openConversation(id);
      })
      .catch(() => {
        // showChat flushes the editor; openers toast their own errors.
      });
  }, [id, kind, openConversation, select, showChat]);
  const Icon = kind === "entry" ? NotebookTextIcon : MessageCircleIcon;
  return (
    <li>
      <button className={rowClassName} onClick={handleClick} type="button">
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="sr-only">
            {kind === "entry" ? "Entry: " : "Chat: "}
          </span>
          {row.title}
        </span>
        <time
          className="shrink-0 text-muted-foreground text-sm tabular-nums"
          dateTime={group === "today" ? row.updatedAt : row.day}
        >
          {homeRowDate(row, group)}
        </time>
      </button>
    </li>
  );
}

function EndButtons() {
  const { showChat, showJournal } = useJournalActions();
  const handleEntries = useCallback(() => {
    showJournal().catch(() => undefined);
  }, [showJournal]);
  const handleChats = useCallback(() => {
    showChat().catch(() => undefined);
  }, [showChat]);
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        className="h-10.5 px-4 text-[15px]"
        onClick={handleEntries}
        variant="outline"
      >
        All entries
      </Button>
      <Button
        className="h-10.5 px-4 text-[15px]"
        onClick={handleChats}
        variant="outline"
      >
        All chats
      </Button>
    </div>
  );
}

function HomeListsSkeleton() {
  return (
    <output className="flex flex-col gap-8">
      <span className="sr-only">Loading Home</span>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </output>
  );
}
