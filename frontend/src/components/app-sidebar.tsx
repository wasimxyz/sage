import {
  ImportIcon,
  MessageCircleIcon,
  NotebookTextIcon,
  PlusIcon,
  RotateCcwClockIcon,
  SettingsIcon,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { ChatList } from "@/components/chat/chat-list";
import { preloadChatLayout } from "@/components/chat-layout-loader";
import { useChat } from "@/components/chat-provider";
import { DreamNavItem } from "@/components/dream-nav";
import { EntriesList } from "@/components/entries-list";
import { useFileMenu } from "@/components/file-menu-provider";
import { Hint } from "@/components/hint";
import {
  useJournalActions,
  useJournalEntries,
  useJournalView,
} from "@/components/journal-context";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { MenuShortcut } from "@/components/menu-shortcut";
import { ScreenActiveProvider } from "@/components/screen-active";
import { SearchNavItem } from "@/components/search-dialog";
import { SettingsMenu } from "@/components/settings-menu";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { shortcuts } from "@/lib/shortcuts";
import {
  type SidebarAction,
  type SidebarTab,
  sidebarActions,
  tabForSection,
} from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";

// Sidebar rows are a little taller than the menu's default, like the lists.
const rowClassName = "h-9";

/**
 * The sidebar: a Chat / Journal switch in the title bar row, the tab's
 * actions, its chats or entries, and Dream and Settings at the bottom.
 * Settings swaps it for its own menu.
 */
export function AppSidebar() {
  const { section, sidebarMenu } = useJournalView();
  const tab = tabForSection(section);
  const onSettings = sidebarMenu === "settings" || tab === null;
  return (
    <Sidebar
      className="md:[&_[data-slot=sidebar-inner]]:pt-[calc(var(--titlebar-height)-0.5rem)]"
      collapsible="offcanvas"
    >
      <SidebarTopRow>
        {onSettings ? null : <SidebarTabs tab={tab} />}
      </SidebarTopRow>
      {onSettings ? (
        <SidebarContent>
          <SettingsMenu />
        </SidebarContent>
      ) : (
        <TabSidebar tab={tab} />
      )}
    </Sidebar>
  );
}

/**
 * The title bar row across the sidebar. Its empty space drags the window,
 * and the switch sits at its right end, beside the traffic lights and the
 * sidebar button.
 */
function SidebarTopRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="absolute inset-x-0 top-0 flex h-(--titlebar-height) items-center justify-end pr-2"
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      {children}
    </div>
  );
}

/**
 * Two icon buttons in a nav, not a toggle group: each is its own stop for
 * Tab, and the open tab is marked as the current page.
 */
function SidebarTabs({ tab }: { tab: SidebarTab }) {
  const { showChatTab, showJournal } = useJournalActions();
  const openChat = useCallback(() => {
    showChatTab().catch(() => undefined);
  }, [showChatTab]);
  const openJournal = useCallback(() => {
    showJournal().catch(() => undefined);
  }, [showJournal]);
  return (
    <nav
      aria-label="Chat or Journal"
      className="bg-sidebar-accent flex items-center gap-0.5 rounded-lg p-0.5"
    >
      <SidebarTabButton
        active={tab === "chat"}
        label="Chat"
        onClick={openChat}
        onPreload={preloadChatLayout}
      >
        <MessageCircleIcon />
      </SidebarTabButton>
      <SidebarTabButton
        active={tab === "journal"}
        label="Journal"
        onClick={openJournal}
      >
        <NotebookTextIcon />
      </SidebarTabButton>
    </nav>
  );
}

function SidebarTabButton({
  active,
  children,
  label,
  onClick,
  onPreload,
}: {
  active: boolean;
  children: ReactNode;
  label: string;
  onClick: () => void;
  onPreload?: () => void;
}) {
  return (
    <Hint label={label}>
      <Button
        aria-current={active ? "page" : undefined}
        aria-label={label}
        className={cn(
          "text-sidebar-foreground/80 h-7 w-8.5 rounded-md",
          active
            ? "bg-background text-sidebar-foreground hover:bg-background dark:bg-sidebar-foreground/15 dark:hover:bg-sidebar-foreground/15 shadow-xs"
            : "hover:bg-background/50 dark:hover:bg-sidebar-foreground/10"
        )}
        onClick={onClick}
        onFocus={onPreload}
        onPointerEnter={onPreload}
        size="icon-sm"
        variant="ghost"
      >
        {children}
      </Button>
    </Hint>
  );
}

/** A tab's actions, its list, and the rows at the bottom. */
function TabSidebar({ tab }: { tab: SidebarTab }) {
  return (
    <>
      <SidebarGroup className="pt-4 pb-0">
        <SidebarGroupContent>
          <TabActions tab={tab} />
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="min-h-0 flex-1 pb-0">
        <SidebarGroupLabel>
          {tab === "chat" ? "Chats" : "Entries"}
        </SidebarGroupLabel>
        <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
          {/* Both lists stay mounted, so each keeps its scroll and its rows.
              The hidden one closes its menus. */}
          <TabList active={tab === "chat"}>
            <SidebarChats />
          </TabList>
          <TabList active={tab === "journal"}>
            <SidebarEntries />
          </TabList>
        </div>
      </SidebarGroup>
      <SidebarFooter className="gap-1 pt-1">
        <SidebarSeparator className="mx-2 mb-1" />
        <SidebarMenu className="gap-px">
          <DreamNavItem className={rowClassName} />
          <SettingsItem />
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

function TabList({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ScreenActiveProvider active={active}>
      <div hidden={!active} inert={!active}>
        {children}
      </div>
    </ScreenActiveProvider>
  );
}

function TabActions({ tab }: { tab: SidebarTab }) {
  const { memoryEnabled } = useMemoryFeature();
  return (
    <SidebarMenu className="gap-px">
      {sidebarActions(tab, memoryEnabled).map((action) => (
        <TabAction action={action} key={action} />
      ))}
    </SidebarMenu>
  );
}

function TabAction({ action }: { action: SidebarAction }) {
  if (action === "search") {
    return <SearchNavItem className={rowClassName} />;
  }
  if (action === "new-chat") {
    return <NewChatItem />;
  }
  if (action === "new-entry") {
    return <NewEntryItem />;
  }
  if (action === "import") {
    return <ImportItem />;
  }
  return <MemoriesItem />;
}

function NewChatItem() {
  const { showChat } = useJournalActions();
  const {
    actions: { newChat },
  } = useChat();
  const start = useCallback(() => {
    showChat()
      .then(newChat)
      .catch(() => undefined);
  }, [newChat, showChat]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+N"
        className={rowClassName}
        onClick={start}
      >
        <PlusIcon />
        <span className="truncate">New chat</span>
        <MenuShortcut>{shortcuts.newItem}</MenuShortcut>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NewEntryItem() {
  const { startDraft } = useJournalActions();
  const start = useCallback(() => {
    startDraft().catch(() => undefined);
  }, [startDraft]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+N"
        className={rowClassName}
        onClick={start}
      >
        <PlusIcon />
        <span className="truncate">New entry</span>
        <MenuShortcut>{shortcuts.newItem}</MenuShortcut>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The same picker and preview as File > Import. */
function ImportItem() {
  const {
    actions: { openImport },
  } = useFileMenu();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+O"
        className={rowClassName}
        onClick={openImport}
      >
        <ImportIcon />
        <span className="truncate">Import</span>
        <MenuShortcut>{shortcuts.import}</MenuShortcut>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function MemoriesItem() {
  const { showMemories } = useJournalActions();
  const { section } = useJournalView();
  const open = useCallback(() => {
    showMemories().catch(() => undefined);
  }, [showMemories]);
  const onMemories = section === "memories";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-current={onMemories ? "page" : undefined}
        className={rowClassName}
        isActive={onMemories}
        onClick={open}
      >
        <RotateCcwClockIcon />
        <span className="truncate">Memories</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SettingsItem() {
  const { showSettings } = useJournalActions();
  const open = useCallback(() => {
    showSettings().catch(() => undefined);
  }, [showSettings]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+,"
        className={rowClassName}
        onClick={open}
      >
        <SettingsIcon />
        <span className="truncate">Settings</span>
        <MenuShortcut>{shortcuts.settings}</MenuShortcut>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarChats() {
  const { section } = useJournalView();
  return <ChatList onScreen={section === "chat"} />;
}

/** The entry list reads the entries here, so a save redraws only the list. */
function SidebarEntries() {
  const { deleteEntry, select } = useJournalActions();
  const { entries, loadingList } = useJournalEntries();
  const { section, selectedId } = useJournalView();
  const openEntry = useCallback(
    (id: number) => {
      select(id).catch(() => undefined);
    },
    [select]
  );
  return (
    <EntriesList
      entries={entries}
      loading={loadingList}
      onDelete={deleteEntry}
      onSelect={openEntry}
      selectedId={section === "journal" ? selectedId : null}
    />
  );
}
