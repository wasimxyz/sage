import {
  HouseIcon,
  MessageCircleIcon,
  NotebookTextIcon,
  RotateCcwClockIcon,
  SettingsIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import { onOpenSettings } from "@/bridge";
import { AppTitlebar } from "@/components/app-titlebar";
import { preloadChatLayout } from "@/components/chat-layout-loader";
import { ChatRoute } from "@/components/chat-route";
import {
  DreamConfirmDialog,
  DreamNav,
  DreamStartAnnouncement,
} from "@/components/dream-nav";
import { HomeScreen } from "@/components/home-screen";
import {
  type Section,
  type SidebarMenu as SidebarMenuName,
  useJournalActions,
  useJournalView,
} from "@/components/journal-context";
import { JournalLayout } from "@/components/journal-layout";
import { MemoriesScreen } from "@/components/memories-screen";
import { useMemoryFeature } from "@/components/memory-feature-provider";
import { MenuShortcut } from "@/components/menu-shortcut";
import { ScreenActiveProvider } from "@/components/screen-active";
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
import { useNewShortcut } from "@/hooks/use-new-shortcut";
import { useRouteSync } from "@/hooks/use-route-sync";
import { useWindowFullscreen } from "@/hooks/use-window-fullscreen";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

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
            <AppMain />
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
  const { showSettings } = useJournalActions();
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
  const { sidebarMenu } = useJournalView();
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
  const { showChat, showHome, showJournal, showMemories } = useJournalActions();
  const { section } = useJournalView();
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
  const { showSettings } = useJournalActions();
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

// One element for the life of the shell. A render of AppMain, such as for a
// change in the journal, then leaves the hidden chat alone.
const chatLayout = <ChatRoute />;

function AppMain() {
  const { section } = useJournalView();
  const onChat = section === "chat";
  // Chat mounts the first time it opens and then stays, out of sight while
  // another screen shows. The transcript, its scroll, and a reply that is
  // still coming in are as you left them when you come back. It is hidden,
  // not removed from the layout, so the scroll and the panel keep measuring.
  const [chatMounted, setChatMounted] = useState(onChat);
  if (onChat && !chatMounted) {
    setChatMounted(true);
  }
  return (
    <>
      {chatMounted ? (
        <ScreenActiveProvider active={onChat}>
          <div
            aria-hidden={onChat ? undefined : true}
            className={cn(
              "absolute inset-0 flex min-h-0 min-w-0 flex-col",
              !onChat && "invisible"
            )}
            inert={!onChat}
          >
            {chatLayout}
          </div>
        </ScreenActiveProvider>
      ) : null}
      {onChat ? null : <OtherScreen section={section} />}
    </>
  );
}

/** Every screen but Chat. These unmount when you leave them. */
function OtherScreen({ section }: { section: Section }) {
  const { memoryEnabled } = useMemoryFeature();
  if (section === "home") {
    return <HomeScreen />;
  }
  if (section === "memories" && memoryEnabled) {
    return <MemoriesScreen />;
  }
  if (section === "settings") {
    return <SettingsScreen />;
  }
  return <JournalLayout />;
}
