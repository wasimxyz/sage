import { SearchIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  type ChatSearchHit,
  type JournalSearchResult,
  type MemorySearchHit,
  searchConversations,
  searchEntries,
  searchMemories,
} from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { useJournal } from "@/components/journal-context";
import { useMemories } from "@/components/memories-provider";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { formatRelativeAge } from "@/lib/format-relative-age";
import {
  type SearchTab,
  searchHitsReady,
  visibleHits,
} from "@/lib/search-hits";
import { eventDateKey } from "@/lib/sort-events";
import { cn } from "@/lib/utils";

const searchDebounceMs = 150;
const whitespacePattern = /\s+/;
const emptyMeta = {};
const searchResultRowClassName =
  "flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50";
const searchResultActiveClassName = "bg-foreground/10 hover:bg-foreground/10";
const emptyHits: SearchHit[] = [];
const emptyJournalHits: JournalSearchResult[] = [];
const emptyConversationHits: ChatSearchHit[] = [];
const emptyMemoryHits: MemorySearchHit[] = [];

type SearchHit =
  | { kind: "conversation"; result: ChatSearchHit }
  | { kind: "journal"; result: JournalSearchResult }
  | { kind: "memory"; result: MemorySearchHit };

const searchTabs: { label: string; value: SearchTab }[] = [
  { label: "All", value: "all" },
  { label: "Journal", value: "journal" },
  { label: "Conversations", value: "conversations" },
  { label: "Memories", value: "memories" },
];
const searchTabsWithoutMemories = searchTabs.filter(
  (item) => item.value !== "memories"
);

interface SearchState {
  open: boolean;
}

interface SearchActions {
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

interface SearchContextValue {
  actions: SearchActions;
  meta: Record<string, never>;
  state: SearchState;
}

const SearchContext = createContext<SearchContextValue | null>(null);

function useSearch(): SearchContextValue {
  const value = use(SearchContext);
  if (!value) {
    throw new Error("SearchProvider is missing.");
  }
  return value;
}

interface SearchFormState {
  activeIndex: number;
  conversationHits: ChatSearchHit[];
  conversationQuery: string;
  journalHits: JournalSearchResult[];
  journalQuery: string;
  memoryHits: MemorySearchHit[];
  memoryQuery: string;
  query: string;
  tab: SearchTab;
}

interface SearchFormActions {
  openHit: (hit: SearchHit) => Promise<void>;
  setActiveIndex: (index: number) => void;
  setQuery: (query: string) => void;
  setTab: (tab: SearchTab) => void;
}

interface SearchFormContextValue {
  actions: SearchFormActions;
  meta: { listId: string };
  state: SearchFormState;
}

const SearchFormContext = createContext<SearchFormContextValue | null>(null);

function useSearchForm(): SearchFormContextValue {
  const value = use(SearchFormContext);
  if (!value) {
    throw new Error("SearchForm is missing.");
  }
  return value;
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat) {
        return;
      }
      if (
        event.code !== "KeyK" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [toggle]);

  const actions = useMemo<SearchActions>(
    () => ({
      setOpen,
      toggle,
    }),
    [toggle]
  );

  const value = useMemo<SearchContextValue>(
    () => ({
      actions,
      meta: emptyMeta,
      state: { open },
    }),
    [actions, open]
  );

  return <SearchContext value={value}>{children}</SearchContext>;
}

export function SearchNavItem() {
  const {
    actions: { toggle },
  } = useSearch();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+K Control+K"
        onClick={toggle}
        tooltip="Search"
      >
        <SearchIcon />
        <span>Search</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SearchDialog() {
  const {
    actions: { setOpen },
    state: { open },
  } = useSearch();
  const popupRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback<
    NonNullable<ComponentProps<typeof Dialog>["onOpenChange"]>
  >(
    (next, details) => {
      if (next) {
        setOpen(true);
        return;
      }
      if (details.reason === "focus-out") {
        details.cancel();
        return;
      }
      if (
        details.reason === "outside-press" &&
        clickIsInsideElement(details.event, popupRef.current)
      ) {
        details.cancel();
        return;
      }
      setOpen(false);
    },
    [setOpen]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup
        className="flex max-h-[min(32rem,calc(100vh-4rem))] w-full max-w-lg flex-col gap-0 overflow-hidden overscroll-contain p-0 sm:max-w-lg"
        ref={popupRef}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Search journal entries and conversations.
          </DialogDescription>
        </DialogHeader>
        {open ? <SearchForm /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function SearchForm() {
  const {
    actions: { select, showChat, showMemories },
  } = useJournal();
  const {
    actions: { openConversation },
  } = useChat();
  const {
    actions: { openSearchHit },
  } = useMemories();
  const {
    actions: { setOpen },
  } = useSearch();
  const { memoryEnabled } = useMemoryFeature();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [tab, setTabState] = useState<SearchTab>("all");
  const [journalHits, setJournalHits] = useState(emptyJournalHits);
  const [conversationHits, setConversationHits] = useState(
    emptyConversationHits
  );
  const [memoryHits, setMemoryHits] = useState(emptyMemoryHits);
  const [journalQuery, setJournalQuery] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchGenRef = useRef(0);

  const openHit = useCallback(
    async (hit: SearchHit) => {
      if (hit.kind === "journal") {
        await select(hit.result.id);
        setOpen(false);
        return;
      }
      if (hit.kind === "conversation") {
        await showChat();
        openConversation(
          hit.result.conversationId,
          hit.result.seq === null ? undefined : { seq: hit.result.seq }
        );
        setOpen(false);
        return;
      }
      if (!memoryEnabled) {
        return;
      }
      await showMemories();
      openSearchHit(hit.result);
      setOpen(false);
    },
    [
      memoryEnabled,
      openConversation,
      openSearchHit,
      select,
      setOpen,
      showChat,
      showMemories,
    ]
  );

  const setTab = useCallback(
    (next: SearchTab) => {
      if (!memoryEnabled && next === "memories") {
        return;
      }
      setTabState(next);
      setActiveIndex(0);
    },
    [memoryEnabled]
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      searchGenRef.current += 1;
      setJournalHits(emptyJournalHits);
      setConversationHits(emptyConversationHits);
      setMemoryHits(emptyMemoryHits);
      setJournalQuery("");
      setConversationQuery("");
      setMemoryQuery("");
      setActiveIndex(0);
      return;
    }

    const needJournal =
      tab !== "conversations" && tab !== "memories" && journalQuery !== trimmed;
    const needChat =
      tab !== "journal" && tab !== "memories" && conversationQuery !== trimmed;
    const needMemory =
      memoryEnabled &&
      tab !== "journal" &&
      tab !== "conversations" &&
      memoryQuery !== trimmed;
    if (!(needJournal || needChat || needMemory)) {
      return;
    }

    searchGenRef.current += 1;
    const gen = searchGenRef.current;
    const timer = window.setTimeout(() => {
      const journalPromise = needJournal
        ? searchEntries(trimmed)
        : Promise.resolve(null);
      const chatPromise = needChat
        ? searchConversations(trimmed)
        : Promise.resolve(null);
      const memoryPromise = needMemory
        ? searchMemories(trimmed)
        : Promise.resolve(null);
      Promise.allSettled([journalPromise, chatPromise, memoryPromise]).then(
        ([journalResult, chatResult, memoryResult]) => {
          if (gen !== searchGenRef.current) {
            return;
          }
          const errors: string[] = [];
          if (needJournal) {
            setJournalHits(
              hitsFromSettled(journalResult, emptyJournalHits, errors)
            );
            setJournalQuery(trimmed);
          }
          if (needChat) {
            setConversationHits(
              hitsFromSettled(chatResult, emptyConversationHits, errors)
            );
            setConversationQuery(trimmed);
          }
          if (needMemory) {
            setMemoryHits(
              hitsFromSettled(memoryResult, emptyMemoryHits, errors)
            );
            setMemoryQuery(trimmed);
          }
          setActiveIndex(0);
          if (errors[0]) {
            toast.error(errors[0]);
          }
        }
      );
    }, searchDebounceMs);

    return () => {
      window.clearTimeout(timer);
      searchGenRef.current += 1;
    };
  }, [conversationQuery, journalQuery, memoryEnabled, memoryQuery, query, tab]);

  const actions = useMemo<SearchFormActions>(
    () => ({
      openHit,
      setActiveIndex,
      setQuery,
      setTab,
    }),
    [openHit, setTab]
  );

  const value = useMemo<SearchFormContextValue>(
    () => ({
      actions,
      meta: { listId },
      state: {
        activeIndex,
        conversationHits,
        conversationQuery,
        journalHits,
        journalQuery,
        memoryHits,
        memoryQuery,
        query,
        tab,
      },
    }),
    [
      actions,
      activeIndex,
      conversationHits,
      conversationQuery,
      journalHits,
      journalQuery,
      listId,
      memoryHits,
      memoryQuery,
      query,
      tab,
    ]
  );

  return (
    <SearchFormContext value={value}>
      <div className="flex min-h-0 flex-1 flex-col">
        <SearchQueryField />
        <SearchTabs />
        <ScrollArea className="min-h-0 flex-1">
          <SearchResults />
        </ScrollArea>
      </div>
    </SearchFormContext>
  );
}

function SearchQueryField() {
  const {
    actions: { openHit, setActiveIndex, setQuery },
    meta: { listId },
    state: { activeIndex, query, tab },
  } = useSearchForm();
  const { memoryEnabled } = useMemoryFeature();
  const hits = useVisibleHits();
  const trimmedQuery = query.trim();
  const activeHit = hits[activeIndex];
  const activeOptionId = activeHit
    ? searchOptionId(listId, activeHit)
    : undefined;

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setQuery(event.target.value);
    },
    [setQuery]
  );

  const handleQueryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(
          hits.length === 0 ? 0 : Math.min(activeIndex + 1, hits.length - 1)
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(Math.max(activeIndex - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        if (!activeHit) {
          return;
        }
        event.preventDefault();
        openHit(activeHit).catch(() => {
          // Openers already toast their own errors.
        });
      }
    },
    [activeHit, activeIndex, hits.length, openHit, setActiveIndex]
  );

  return (
    <div className="flex items-center gap-2 border-b px-3 focus-within:bg-muted/40">
      <SearchIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <Input
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-controls={hits.length > 0 ? listId : undefined}
        aria-expanded={trimmedQuery.length > 0}
        aria-label={searchAriaLabel(tab, memoryEnabled)}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        autoFocus
        className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        name="app-search"
        onChange={handleQueryChange}
        onKeyDown={handleQueryKeyDown}
        placeholder={searchPlaceholder(tab, memoryEnabled)}
        role="combobox"
        spellCheck={false}
        type="search"
        value={query}
      />
    </div>
  );
}

function SearchTabs() {
  const {
    actions: { setTab },
    state: { tab },
  } = useSearchForm();
  const { memoryEnabled } = useMemoryFeature();
  const tabs = memoryEnabled ? searchTabs : searchTabsWithoutMemories;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setTabButtonRef = useCallback(
    (index: number, node: HTMLButtonElement | null) => {
      tabRefs.current[index] = node;
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const current = tabs.findIndex((entry) => entry.value === tab);
      if (current < 0) {
        return;
      }
      let next = current;
      if (event.key === "ArrowRight") {
        next = Math.min(current + 1, tabs.length - 1);
      } else if (event.key === "ArrowLeft") {
        next = Math.max(current - 1, 0);
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = tabs.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const item = tabs[next];
      if (!item || next === current) {
        return;
      }
      setTab(item.value);
      tabRefs.current[next]?.focus();
    },
    [setTab, tab, tabs]
  );

  return (
    <div
      aria-label="Search in"
      className="flex gap-1 border-b px-3 py-2"
      onKeyDown={handleKeyDown}
      role="tablist"
    >
      {tabs.map((item, index) => (
        <SearchTabButton
          index={index}
          key={item.value}
          selected={item.value === tab}
          setTab={setTab}
          setTabButtonRef={setTabButtonRef}
          tab={item}
        />
      ))}
    </div>
  );
}

function SearchResults() {
  const {
    meta: { listId },
    state: { conversationQuery, journalQuery, memoryQuery, query, tab },
  } = useSearchForm();
  const { memoryEnabled } = useMemoryFeature();
  const hits = useVisibleHits();
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return <SearchStatus>{searchEmptyHint(tab, memoryEnabled)}</SearchStatus>;
  }
  if (
    !searchHitsReady(
      tab,
      trimmedQuery,
      journalQuery,
      conversationQuery,
      memoryQuery,
      memoryEnabled
    )
  ) {
    return <SearchStatus>Searching…</SearchStatus>;
  }
  if (hits.length === 0) {
    return <SearchStatus>{searchMissHint(tab, memoryEnabled)}</SearchStatus>;
  }
  if (tab !== "all") {
    return (
      <SearchListbox listId={listId}>
        <SearchHitRows hits={hits} startIndex={0} />
      </SearchListbox>
    );
  }
  const journalHits = hits.filter((hit) => hit.kind === "journal");
  const conversationHits = hits.filter((hit) => hit.kind === "conversation");
  const memoryHits = hits.filter((hit) => hit.kind === "memory");
  return (
    <SearchListbox listId={listId}>
      {journalHits.length > 0 ? (
        <SearchGroup heading="Journal">
          <SearchHitRows hits={journalHits} startIndex={0} />
        </SearchGroup>
      ) : null}
      {conversationHits.length > 0 ? (
        <SearchGroup heading="Conversations">
          <SearchHitRows
            hits={conversationHits}
            startIndex={journalHits.length}
          />
        </SearchGroup>
      ) : null}
      {memoryHits.length > 0 ? (
        <SearchGroup heading="Memories">
          <SearchHitRows
            hits={memoryHits}
            startIndex={journalHits.length + conversationHits.length}
          />
        </SearchGroup>
      ) : null}
    </SearchListbox>
  );
}

function SearchListbox({
  children,
  listId,
}: {
  children: ReactNode;
  listId: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 p-2"
      id={listId}
      role="listbox"
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

function SearchTabButton({
  index,
  selected,
  setTab,
  setTabButtonRef,
  tab,
}: {
  index: number;
  selected: boolean;
  setTab: (tab: SearchTab) => void;
  setTabButtonRef: (index: number, node: HTMLButtonElement | null) => void;
  tab: (typeof searchTabs)[number];
}) {
  const handleClick = useCallback(() => {
    setTab(tab.value);
  }, [setTab, tab.value]);
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      setTabButtonRef(index, node);
    },
    [index, setTabButtonRef]
  );
  return (
    <button
      aria-selected={selected}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1 text-sm",
        selected
          ? [searchResultActiveClassName, "font-medium text-foreground"]
          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      )}
      onClick={handleClick}
      ref={handleRef}
      role="tab"
      tabIndex={selected ? 0 : -1}
      type="button"
    >
      {tab.label}
    </button>
  );
}

function SearchGroup({
  children,
  heading,
}: {
  children: ReactNode;
  heading: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 py-1 font-medium text-muted-foreground text-xs">
        {heading}
      </div>
      {children}
    </div>
  );
}

function SearchHitRows({
  hits,
  startIndex,
}: {
  hits: SearchHit[];
  startIndex: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {hits.map((hit, index) => (
        <SearchHitRow
          hit={hit}
          key={searchHitKey(hit)}
          resultIndex={startIndex + index}
        />
      ))}
    </div>
  );
}

function SearchHitRow({
  hit,
  resultIndex,
}: {
  hit: SearchHit;
  resultIndex: number;
}) {
  if (hit.kind === "journal") {
    return <SearchJournalItem result={hit.result} resultIndex={resultIndex} />;
  }
  if (hit.kind === "conversation") {
    return (
      <SearchConversationItem result={hit.result} resultIndex={resultIndex} />
    );
  }
  return <SearchMemoryItem result={hit.result} resultIndex={resultIndex} />;
}

function SearchJournalItem({
  result,
  resultIndex,
}: {
  result: JournalSearchResult;
  resultIndex: number;
}) {
  const excerpt = normalizeExcerpt(result.excerpt);
  const title = result.title.trim();
  const showExcerpt = excerpt.length > 0 && excerpt !== title;
  const date = formatRelativeAge(result.date);
  return (
    <SearchResult hit={{ kind: "journal", result }} resultIndex={resultIndex}>
      <SearchResultLead>
        <SearchResultTitle>{result.title}</SearchResultTitle>
        {date.length > 0 ? <SearchResultMeta>{date}</SearchResultMeta> : null}
      </SearchResultLead>
      {showExcerpt ? (
        <SearchResultExcerpt>{excerpt}</SearchResultExcerpt>
      ) : null}
    </SearchResult>
  );
}

function SearchConversationItem({
  result,
  resultIndex,
}: {
  result: ChatSearchHit;
  resultIndex: number;
}) {
  const excerpt = normalizeExcerpt(result.excerpt);
  const title = result.title.trim();
  const showExcerpt = excerpt.length > 0 && excerpt !== title;
  const date = formatRelativeAge(result.updatedAt);
  return (
    <SearchResult
      hit={{ kind: "conversation", result }}
      resultIndex={resultIndex}
    >
      <SearchResultLead>
        <SearchResultTitle>{result.title}</SearchResultTitle>
        {date.length > 0 ? <SearchResultMeta>{date}</SearchResultMeta> : null}
      </SearchResultLead>
      {showExcerpt ? (
        <SearchResultExcerpt>{excerpt}</SearchResultExcerpt>
      ) : null}
    </SearchResult>
  );
}

function SearchResult({
  children,
  hit,
  resultIndex,
}: {
  children: ReactNode;
  hit: SearchHit;
  resultIndex: number;
}) {
  const {
    actions: { openHit, setActiveIndex },
    meta: { listId },
    state: { activeIndex },
  } = useSearchForm();
  const rowRef = useRef<HTMLButtonElement>(null);
  const active = resultIndex === activeIndex;

  useEffect(() => {
    if (!active) {
      return;
    }
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const handleClick = useCallback(() => {
    openHit(hit).catch(() => {
      // Openers already toast their own errors.
    });
  }, [hit, openHit]);

  const handlePointerMove = useCallback(() => {
    setActiveIndex(resultIndex);
  }, [resultIndex, setActiveIndex]);

  return (
    <button
      aria-selected={active}
      className={cn(
        searchResultRowClassName,
        active ? searchResultActiveClassName : null
      )}
      data-search-active={active ? "" : undefined}
      id={searchOptionId(listId, hit)}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      ref={rowRef}
      role="option"
      tabIndex={-1}
      type="button"
    >
      {children}
    </button>
  );
}

function SearchResultLead({ children }: { children: ReactNode }) {
  return (
    <span className="flex w-full items-center justify-between gap-4">
      {children}
    </span>
  );
}

function SearchResultTitle({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate font-medium">{children}</span>;
}

function SearchResultMeta({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
      {children}
    </span>
  );
}

function SearchResultExcerpt({ children }: { children: ReactNode }) {
  return (
    <span className="line-clamp-2 text-muted-foreground text-xs">
      {children}
    </span>
  );
}

function SearchStatus({ children }: { children: ReactNode }) {
  return (
    <output className="block px-3 py-8 text-center text-muted-foreground text-sm">
      {children}
    </output>
  );
}

function useVisibleHits(): SearchHit[] {
  const {
    state: {
      conversationHits,
      conversationQuery,
      journalHits,
      journalQuery,
      memoryHits,
      memoryQuery,
      query,
      tab,
    },
  } = useSearchForm();
  const { memoryEnabled } = useMemoryFeature();
  return useMemo(() => {
    const trimmedQuery = query.trim();
    if (
      !searchHitsReady(
        tab,
        trimmedQuery,
        journalQuery,
        conversationQuery,
        memoryQuery,
        memoryEnabled
      )
    ) {
      return emptyHits;
    }
    return visibleHits(tab, journalHits, conversationHits, memoryHits);
  }, [
    conversationHits,
    conversationQuery,
    journalHits,
    journalQuery,
    memoryHits,
    memoryQuery,
    memoryEnabled,
    query,
    tab,
  ]);
}

function searchOptionId(listId: string, hit: SearchHit): string {
  return `${listId}-option-${searchHitKey(hit)}`;
}

function searchHitKey(hit: SearchHit): string {
  if (hit.kind === "journal") {
    return `journal-${hit.result.id}`;
  }
  if (hit.kind === "conversation") {
    return `conversation-${hit.result.conversationId}-${hit.result.seq ?? "title"}`;
  }
  return `memory-${hit.result.kind}-${hit.result.id}`;
}

function searchAriaLabel(tab: SearchTab, memoryEnabled: boolean): string {
  if (tab === "journal") {
    return "Search journal entries";
  }
  if (tab === "conversations") {
    return "Search conversations";
  }
  if (tab === "memories") {
    return "Search memories";
  }
  return memoryEnabled
    ? "Search journal, conversations, and memories"
    : "Search journal and conversations";
}

function searchPlaceholder(tab: SearchTab, memoryEnabled: boolean): string {
  if (tab === "journal") {
    return "Search titles and entry text…";
  }
  if (tab === "conversations") {
    return "Search chat titles and messages…";
  }
  if (tab === "memories") {
    return "Search profile, topics, and events…";
  }
  return memoryEnabled
    ? "Search journal, conversations, and memories…"
    : "Search journal and conversations…";
}

function searchEmptyHint(tab: SearchTab, memoryEnabled: boolean): string {
  if (tab === "journal") {
    return "Search titles and entry text";
  }
  if (tab === "conversations") {
    return "Search chat titles and messages";
  }
  if (tab === "memories") {
    return "Search profile, topics, and events";
  }
  return memoryEnabled
    ? "Search journal, conversations, and memories"
    : "Search journal and conversations";
}

function searchMissHint(tab: SearchTab, memoryEnabled: boolean): string {
  if (tab === "journal") {
    return "No matching entries";
  }
  if (tab === "conversations") {
    return "No matching conversations";
  }
  if (tab === "memories") {
    return "No matching memories";
  }
  return memoryEnabled
    ? "No matches in journal, conversations, or memories"
    : "No matches in journal or conversations";
}

function normalizeExcerpt(excerpt: string): string {
  return excerpt.trim().replace(whitespacePattern, " ");
}

function searchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not search.";
}

function SearchMemoryItem({
  result,
  resultIndex,
}: {
  result: MemorySearchHit;
  resultIndex: number;
}) {
  if (result.kind === "event") {
    return <SearchEventMemoryItem result={result} resultIndex={resultIndex} />;
  }
  if (result.kind === "profile") {
    return (
      <SearchProfileMemoryItem result={result} resultIndex={resultIndex} />
    );
  }
  return <SearchFactMemoryItem result={result} resultIndex={resultIndex} />;
}

function SearchProfileMemoryItem({
  result,
  resultIndex,
}: {
  result: MemorySearchHit;
  resultIndex: number;
}) {
  return (
    <SearchSentenceMemoryItem
      excerpt={result.excerpt}
      result={result}
      resultIndex={resultIndex}
      title="You"
    />
  );
}

function SearchFactMemoryItem({
  result,
  resultIndex,
}: {
  result: MemorySearchHit;
  resultIndex: number;
}) {
  return (
    <SearchSentenceMemoryItem
      excerpt={result.excerpt}
      result={result}
      resultIndex={resultIndex}
      title={result.subject}
    />
  );
}

function SearchSentenceMemoryItem({
  excerpt,
  result,
  resultIndex,
  title,
}: {
  excerpt: string;
  result: MemorySearchHit;
  resultIndex: number;
  title: string;
}) {
  const normalized = normalizeExcerpt(excerpt);
  const showExcerpt = normalized.length > 0 && normalized !== title.trim();
  const date = formatRelativeAge(result.updatedAt);
  return (
    <SearchResult hit={{ kind: "memory", result }} resultIndex={resultIndex}>
      <SearchResultLead>
        <SearchResultTitle>{title}</SearchResultTitle>
        {date.length > 0 ? <SearchResultMeta>{date}</SearchResultMeta> : null}
      </SearchResultLead>
      {showExcerpt ? (
        <SearchResultExcerpt>{normalized}</SearchResultExcerpt>
      ) : null}
    </SearchResult>
  );
}

function SearchEventMemoryItem({
  result,
  resultIndex,
}: {
  result: MemorySearchHit;
  resultIndex: number;
}) {
  const excerpt = normalizeExcerpt(result.excerpt);
  const title = result.event.trim();
  const showExcerpt = excerpt.length > 0 && excerpt !== title;
  const dated = eventDateKey(result.occurredAt);
  const dateLabel =
    dated.length === 0
      ? formatRelativeAge(result.updatedAt)
      : formatRelativeAge(dated.slice(0, 10));
  const sourceTitle = result.sourceTitle.trim();
  const showSource = sourceTitle.length > 0;
  return (
    <SearchResult hit={{ kind: "memory", result }} resultIndex={resultIndex}>
      <SearchResultLead>
        <SearchResultTitle>{title}</SearchResultTitle>
        {dateLabel.length > 0 ? (
          <SearchResultMeta>{dateLabel}</SearchResultMeta>
        ) : null}
      </SearchResultLead>
      {showSource ? (
        <SearchResultExcerpt>From {sourceTitle}</SearchResultExcerpt>
      ) : null}
      {showExcerpt && !showSource ? (
        <SearchResultExcerpt>{excerpt}</SearchResultExcerpt>
      ) : null}
    </SearchResult>
  );
}

function clickIsInsideElement(event: Event, element: HTMLElement | null) {
  if (!element) {
    return false;
  }
  if (!("clientX" in event && "clientY" in event)) {
    return false;
  }
  const { clientX, clientY } = event;
  if (typeof clientX !== "number" || typeof clientY !== "number") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function hitsFromSettled<T>(
  result: PromiseSettledResult<T[] | null>,
  empty: T[],
  errors: string[]
): T[] {
  if (result.status === "fulfilled") {
    return result.value ?? empty;
  }
  errors.push(searchErrorMessage(result.reason));
  return empty;
}
