import { MessageCircleIcon, NotebookTextIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type HomeFeed,
  type HomeFeedItem,
  type HomeLatestEntry,
  hasNativeBridge,
  homeFeed,
  onDreamFinished,
  waitForNativeBridge,
} from "@/bridge";
import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { useChat } from "@/components/chat-provider";
import { EntryDateLine } from "@/components/entry-date-line";
import { useJournal } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatHomeHeadingDate,
  formatJournalListDate,
} from "@/lib/format-date";
import { groupHomeFeed, homeSinceDate } from "@/lib/home-feed";
import { oneLinePlainText, stripMarkdown } from "@/lib/journal-plain-text";
import { pageColumnClass } from "@/lib/page-column";
import { cn } from "@/lib/utils";

const emptyFeed: HomeFeed = { items: [], latest: null };

const feedRowClassName =
  "flex w-full cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50";

async function loadHomeFeed(): Promise<HomeFeed> {
  const ready = (await waitForNativeBridge()) && hasNativeBridge();
  if (!ready) {
    throw new Error("Sage needs the desktop app to read your journal.");
  }
  return homeFeed(homeSinceDate());
}

export function HomeScreen() {
  const {
    actions: { startDraft },
  } = useJournal();
  const [feed, setFeed] = useState<HomeFeed>(emptyFeed);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await loadHomeFeed();
      setFeed(next);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Could not load Home."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(
    () =>
      onDreamFinished(() => {
        refresh().catch(() => undefined);
      }),
    [refresh]
  );

  const { older, recent } = groupHomeFeed(feed);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="shrink-0 pt-(--titlebar-height) pb-1"
        data-slot="window-drag"
        onPointerDown={onTitlebarPointerDown}
      >
        <div
          className={cn(
            pageColumnClass,
            "flex h-8 items-center justify-between gap-2"
          )}
        >
          <h2 className="ml-3 min-w-0 truncate font-medium text-base">
            {formatHomeHeadingDate()}
          </h2>
          <Button onClick={startDraft} size="sm">
            <PlusIcon data-icon="inline-start" />
            New entry
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(pageColumnClass, "flex flex-col gap-8 pt-2 pb-4")}>
          <HomeFeedBody
            feed={feed}
            loading={loading}
            older={older}
            recent={recent}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function HomeFeedBody({
  feed,
  loading,
  older,
  recent,
}: {
  feed: HomeFeed;
  loading: boolean;
  older: HomeFeedItem[];
  recent: HomeFeedItem[];
}) {
  if (loading) {
    return <HomeFeedSkeleton />;
  }
  if (feed.latest === null && recent.length === 0 && older.length === 0) {
    return <HomeEmpty />;
  }
  return (
    <>
      {feed.latest === null ? null : (
        <ContinueWritingCard entry={feed.latest} />
      )}
      {recent.length > 0 ? (
        <HomeFeedSection title="Recent">
          {recent.map((item) => (
            <HomeFeedItemRow item={item} key={feedItemKey(item)} />
          ))}
        </HomeFeedSection>
      ) : null}
      {older.length > 0 ? (
        <HomeFeedSection title="Older">
          {older.map((item) => (
            <HomeFeedItemRow item={item} key={feedItemKey(item)} />
          ))}
        </HomeFeedSection>
      ) : null}
    </>
  );
}

function HomeFeedItemRow({ item }: { item: HomeFeedItem }) {
  if (item.kind === "conversation") {
    return <HomeConversationRow item={item} />;
  }
  return <HomeJournalRow item={item} />;
}

function HomeJournalRow({ item }: { item: HomeFeedItem }) {
  const {
    actions: { select },
  } = useJournal();
  const handleClick = useCallback(() => {
    select(item.id).catch(() => {
      // The editor toasts its own load errors.
    });
  }, [item.id, select]);
  return (
    <HomeFeedRow
      date={item.date}
      icon={<NotebookTextIcon />}
      onSelect={handleClick}
      snippet={item.snippet}
      title={item.title}
    />
  );
}

function HomeConversationRow({ item }: { item: HomeFeedItem }) {
  const {
    actions: { showChat },
  } = useJournal();
  const {
    actions: { openConversation },
  } = useChat();
  const handleClick = useCallback(() => {
    showChat()
      .then(() => {
        openConversation(item.id);
      })
      .catch(() => {
        // showChat flushes the editor; openers toast their own errors.
      });
  }, [item.id, openConversation, showChat]);
  return (
    <HomeFeedRow
      date={item.date}
      icon={<MessageCircleIcon />}
      onSelect={handleClick}
      snippet={item.snippet}
      title={item.title}
    />
  );
}

function HomeFeedRow({
  date,
  icon,
  onSelect,
  snippet,
  title,
}: {
  date: string;
  icon: ReactNode;
  onSelect: () => void;
  snippet: string;
  title: string;
}) {
  const plain = oneLinePlainText(snippet);
  return (
    <li>
      <button className={feedRowClassName} onClick={onSelect} type="button">
        <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center justify-between gap-4">
            <span className="min-w-0 truncate font-medium">{title}</span>
            <time className="shrink-0 text-muted-foreground" dateTime={date}>
              {formatJournalListDate(date)}
            </time>
          </span>
          {plain.length > 0 ? (
            <span className="truncate text-muted-foreground">{plain}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function HomeFeedSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function ContinueWritingCard({ entry }: { entry: HomeLatestEntry }) {
  const {
    actions: { select },
  } = useJournal();
  const handleClick = useCallback(() => {
    select(entry.id).catch(() => {
      // The editor toasts its own load errors.
    });
  }, [entry.id, select]);
  const snippet = stripMarkdown(entry.snippet);
  return (
    <button
      aria-label={`Continue writing ${entry.title}`}
      className="w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={handleClick}
      type="button"
    >
      <Card className="gap-3">
        <CardHeader className="gap-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Continue writing
          </p>
          <div className="flex flex-col gap-1">
            <CardTitle className="font-semibold text-lg">
              {entry.title}
            </CardTitle>
            <CardDescription className="text-xs">
              <EntryDateLine date={entry.date} updatedAt={entry.updatedAt} />
            </CardDescription>
          </div>
        </CardHeader>
        {snippet.length > 0 ? (
          <CardContent>
            <p className="line-clamp-3 leading-relaxed">{snippet}</p>
          </CardContent>
        ) : null}
      </Card>
    </button>
  );
}

function HomeFeedSkeleton() {
  return (
    <output className="flex flex-col gap-8">
      <span className="sr-only">Loading Home</span>
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="flex flex-col gap-1">
        <Skeleton className="ml-3 h-3 w-16" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </output>
  );
}

function HomeEmpty() {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <NotebookTextIcon />
        </EmptyMedia>
        <EmptyTitle>Sage</EmptyTitle>
        <EmptyDescription>
          Your journal stays on this computer. Open Journal to read and write.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function feedItemKey(item: HomeFeedItem): string {
  return `${item.kind}-${item.id}`;
}
