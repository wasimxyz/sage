import {
  HouseIcon,
  MessageCircleIcon,
  NotebookTextIcon,
  RotateCcwClockIcon,
  SettingsIcon,
} from "lucide-react";
import { type CSSProperties, lazy, Suspense, useEffect, useState } from "react";

import { onOpenSettings } from "@/bridge";
import { AppTitlebar } from "@/components/app-titlebar";
import { ChatDraftProvider } from "@/components/chat/chat-draft";
import {
  DreamConfirmDialog,
  DreamNav,
  DreamStartAnnouncement,
} from "@/components/dream-nav";
import { HomeScreen } from "@/components/home-screen";
import {
  type SidebarMenu as SidebarMenuName,
  useJournal,
} from "@/components/journal-context";
import { JournalLayout } from "@/components/journal-layout";
import { MemoriesScreen } from "@/components/memories-screen";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { MenuShortcut } from "@/components/menu-shortcut";
import { SearchDialog, SearchProvider } from "@/components/search-dialog";
import { SettingsMenu } from "@/components/settings-menu";
import { SettingsScreen } from "@/components/settings-screen";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useNewShortcut } from "@/hooks/use-new-shortcut";
import { useRouteSync } from "@/hooks/use-route-sync";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";
import { shortcuts } from "@/lib/shortcuts";

// Chat brings Markdown, code, math, and diagram rendering with it. None of
// that is needed until the first time Chat opens, so it loads on demand.
type ChatLayoutComponent = typeof import("@/components/chat-layout").ChatLayout;

// Set once the module has loaded, whether a hover or an open started the load.
let loadedChatLayout: ChatLayoutComponent | null = null;

function loadChatLayout() {
  return import("@/components/chat-layout").then((module) => {
    loadedChatLayout = module.ChatLayout;
    return module;
  });
}

const LazyChatLayout = lazy(() =>
  loadChatLayout().then((module) => ({ default: module.ChatLayout }))
);

// Hovering or focusing the Chat row starts the load, so the screen is usually
// there by the time it is opened.
function preloadChatLayout() {
  loadChatLayout().catch(() => undefined);
}

export function AppShell() {
  const fullscreen = useWindowFullscreen();
  useNewShortcut();
  return (
    <SearchProvider>
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            // 5.375rem clears the traffic lights inset 1rem. In fullscreen the
            // toggle icon lines up with the sidebar icons, which sit 1rem in:
            // 0.125rem + 0.5rem padding + 0.375rem inside the 1.75rem button.
            "--titlebar-leading": fullscreen ? "0.125rem" : "5.375rem",
          } as CSSProperties
        }
      >
        <RouteSync />
        <SettingsMenuListener />
        <AppTitlebar />
        <DreamConfirmDialog />
        <DreamStartAnnouncement />
        <SearchDialog />
        <div className="flex min-h-0 min-w-0 flex-1">
          <AppSidebar />
          <SidebarInset className="min-h-0 overflow-hidden">
            {/* Above AppMain so a half-typed message survives other screens. */}
            <ChatDraftProvider>
              <AppMain />
            </ChatDraftProvider>
          </SidebarInset>
        </div>
      </div>
    </SearchProvider>
  );
}

function RouteSync() {
  useRouteSync();
  return null;
}

/** Sage > Settings opens the settings screen. */
function SettingsMenuListener() {
  const {
    actions: { showSettings },
  } = useJournal();
  useEffect(
    () =>
      onOpenSettings(() => {
        showSettings().catch(() => undefined);
      }),
    [showSettings]
  );
  return null;
}

function AppSidebar() {
  const {
    state: { sidebarMenu },
  } = useJournal();
  return (
    <Sidebar
      className="md:[&_[data-slot=sidebar-inner]]:pt-[calc(var(--titlebar-height)-0.5rem)]"
      collapsible="offcanvas"
    >
      <SidebarContent>
        <SidebarBody menu={sidebarMenu} />
      </SidebarContent>
      {sidebarMenu === "nav" ? <SettingsNav /> : null}
    </Sidebar>
  );
}

function SidebarBody({ menu }: { menu: SidebarMenuName }) {
  if (menu === "settings") {
    return <SettingsMenu />;
  }
  return <NavMenu />;
}

function NavMenu() {
  const {
    actions: { showChat, showHome, showJournal, showMemories },
    state: { section },
  } = useJournal();
  const { memoryEnabled } = useMemoryFeature();
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "home"}
                onClick={showHome}
              >
                <HouseIcon />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "journal"}
                onClick={showJournal}
              >
                <NotebookTextIcon />
                <span>Journal</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={section === "chat"}
                onClick={showChat}
                onFocus={preloadChatLayout}
                onPointerEnter={preloadChatLayout}
              >
                <MessageCircleIcon />
                <span>Chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {memoryEnabled ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={section === "memories"}
                  onClick={showMemories}
                >
                  <RotateCcwClockIcon />
                  <span>Memories</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <DreamNav />
    </>
  );
}

function SettingsNav() {
  const {
    actions: { showSettings },
  } = useJournal();
  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-keyshortcuts="Meta+,"
            className="mb-0.5"
            onClick={showSettings}
          >
            <SettingsIcon />
            <span className="truncate">Settings</span>
            <MenuShortcut>{shortcuts.settings}</MenuShortcut>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function ChatLoading() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
      <Spinner />
    </div>
  );
}

/**
 * Opens Chat. A module that is already here, as after a hover on the Chat row,
 * renders at once. Going through Suspense would still hold its spinner for
 * about 300 ms. Only a cold open takes the lazy path. This is decided once per
 * mount, so a load that finishes later never swaps the element and remounts
 * Chat.
 */
function ChatRoute() {
  const [Loaded] = useState(() => loadedChatLayout);
  if (Loaded) {
    return <Loaded />;
  }
  return (
    <Suspense fallback={<ChatLoading />}>
      <LazyChatLayout />
    </Suspense>
  );
}

function AppMain() {
  const {
    state: { section },
  } = useJournal();
  const { memoryEnabled } = useMemoryFeature();
  if (section === "home") {
    return <HomeScreen />;
  }
  if (section === "chat") {
    return <ChatRoute />;
  }
  if (section === "memories" && memoryEnabled) {
    return <MemoriesScreen />;
  }
  if (section === "settings") {
    return <SettingsScreen />;
  }
  return <JournalLayout />;
}
